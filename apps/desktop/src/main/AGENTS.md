# src/main — AGENTS.md

Notes for the main process as a whole. See `apps/desktop/AGENTS.md` for
app-wide build facts, and the nested files (`git/`, `github/`, `forge/`) for
each area.

## Main cannot tell which profile is asking

PwrGit runs one window per profile (`profile-windows.ts`), but that binding
lives in the **renderer**: `window.pwrgit.profileId` is baked into the window at
creation. `CommandContext` (`command-bus.ts`) carries `signal`, `webContentsId`
and `isMainFrame` — and no profile. So a handler cannot scope a query to the
window that sent it. Two consequences, and both have produced bugs:

- **Scoping only exists where the renderer passes it.** `repo:list` is the
  pattern to copy: `req.profileId ?? profiles.getActiveId()`. Note what the
  fallback means — the *globally active* profile, which is "last used", not the
  profile of the window that asked. A handler that relies on the fallback
  answers a background window with another profile's rows.
- **`emitEvent` goes to every window** (`ipc.ts`). The profile filter is in the
  renderer (`useRepoTree.ts`, `useRemoteActivity.ts`, the clone and fork
  dialogs), so an event that carries no `profileId` cannot be filtered at all.
  Put one on any event whose payload belongs to a profile.

**A `LIMIT` over an unscoped query is the sharp edge.** The rows are ranked
before they are capped, so another profile's rows do not merely appear — they
take result slots, and this profile's rows never reach the reader. Filtering the
answer afterwards, in the renderer or in main, does not give the slots back. If
a query is capped, scope it in SQL.

`RepoIndexer.searchAll` (⌘K) takes a `SearchScope` — which profile's window
asked, and whether it wants the others too (General → Search all profiles, or
the palette's ⇧⌘A footer toggle, which writes the same setting; off by
default). Two things about it are easy to get wrong:

- **The filter is a WHERE clause, not a pass over the answer.** `search_fts`
  carries a `profile_id` column for exactly this (0033), because both of its
  queries are capped.
- **Widened is not unordered.** With the setting on, other profiles' rows are
  reachable but never ahead of this profile's — `profile_id = ? DESC` sits
  between the exact-name tier and bm25. Those rows are how two of the three
  routes to another profile's window work: a hit carries its
  `profileId`/`profileName`, the palette badges every row, and picking one
  opens or focuses **that** profile's window rather than acting here
  (`App.tsx`). Keep them reachable.

## Test it with two profiles, or you have not tested it

A query, cache or sweep that reads rows keyed by repo, worktree or branch needs
a test with **two** profiles in the database and the answer asserted against
one of them. One profile in a fixture cannot fail this way, which is why the
bleeds get found by hand.

The one written for this rule is `git/repo-indexer.profile-scope.test.ts`:
two profiles whose repositories share a branch name and a change-request
number, asserting the scope, the widened order, and that another profile's 200
rows cannot spend the result cap. It needs no git at all — the FTS rows are
written by triggers on insert.

The others worth copying: `profiles/profile-deletion.persistence.test.ts`
("clears owned indexes and selections without touching repositories on disk")
builds two complete profiles and asserts only one is swept;
`git/repo-indexer.test.ts` ("hydrates remote-only search entries for every
persisted repo") asserts a search hit carries its own profile's id;
`git/fork-service.test.ts` ("refuses a repository from another profile") covers
`fork-service.ts`'s ownership check, which is main's only one.

For a cache, the test that matters is the **key**: two profiles whose repos
share a branch name, asserted not to serve each other — the shape
`graph-handlers.test.ts` already uses for scope and worktree ("caches per
scope, so one scope cannot serve the other").
