# Open change requests

This guide covers `OpenPrService`: per-forge-repository open PR lists, locating and fetching their heads, and the PR view. Code paths in backticks are relative to [apps/desktop/src/main/github](../../../apps/desktop/src/main/github/AGENTS.md).

## Open change requests

**`OpenPrService` holds each repository's open change requests**
(`repo_open_pr`, migration 0032). The refs browser's Pull requests tab and ⌘K
read it. It is the only cache that knows a PR whose head was never fetched.

- Same shape as `PrService`, separate state: its own TTLs (10 min on the
  repo-expand sweep, 60 s when the refs browser opens), `lastFailure` and
  generation guard.
- Reads never wait on a forge. `pr:openList` answers from the table, re-lists
  behind it, and announces `pr:openChanged` after each refresh. The answer
  includes rows, `fetchedAt` and `failure`, so the sidebar shows the list's
  age and why it is not newer.
- Rows are diff-written, so an unchanged list re-indexes nothing.

### One list per forge repository

- **One list per forge repository, not per checkout** (migration 0039). Every
  remote a product claims is asked, deduplicated by `forgeRepoKey`
  (`host/path`, lowercased), and named after its first remote, `origin` first.
- In a fork checkout `origin` is your repository; your PR to the original is
  only on `upstream`'s list. Rows are keyed `(repo_id, forge_repo, number)`
  because the two #14s differ. `repo_open_pr_state` has one row per forge
  repository, so each list refreshes and fails alone.
- A remote with no signed-in host is skipped quietly (`unasked`), except the
  first forge remote (`origin` if present), whose missing sign-in is reported.
- A refresh drops rows of a forge repository that no remote points at, but
  never when `git remote -v` failed ("unknown", not "none").

### Locating heads

- **Look for a head on the remote whose repository holds it**
  (`ChangeRequestPlace`), usually the listing remote. If a fork's head is in a
  repository this checkout also has a remote on (your fork, for a PR you sent
  upstream), use it; the PR shows in Local on your branch. Other fork heads
  get a numbered branch that names the remote unless it is `origin`
  (`pr/upstream/405`), so two lists' #405 never share a branch.
- **`list()` spawns nothing in the common case**, because the sidebar calls
  it on every expand and announcement. Heads are located in the branch index
  (`local_branches`, `remote_branches`, `worktrees`; ⌘K uses the same). Remote
  URLs are re-read only when `.git/config` changes, with one `git remote -v`,
  which applies `insteadOf` as `git remote get-url` did.
- The index can lag a terminal fetch, so a label can lag. The verbs cannot:
  the renderer's `reachableLocation` sends every non-worktree row through
  `pr:fetchHead`, which locates with git.
- **Every row is indexed** (`change_request` in `search_fts`, by trigger,
  under its integer `id`). `RepoIndexer.searchAll` answers a hit with the
  worktree, local branch or origin branch holding its head, carrying the PR.
  Only an unheld head is a `change_request` hit; Enter runs `pr:fetchHead`
  first.
- **`fetchHead` never overwrites a branch.** An unfetched same-repository
  head goes to `refs/remotes/origin/<head>`, forced (a tracking ref). A fork's
  goes to `pr/N` *without* `+`, with `branch.pr/N.merge` set to the forge's
  change-request ref so a later pull follows the PR. A head already here is
  returned as-is. Forge names enter a refspec only after
  `git check-ref-format --branch`.
- A number not in the list (merged, closed, or new) is asked of
  `fetchPrsByNumbers` once and remembered five minutes. An omitted answer is
  not remembered.

### The PR view

**`pr:view` reads a change request with no worktree and no forge call** (the
sidebar's PR view).

- Diff and commits come from `git diff -M <merge-base> <head>` and
  `git log <merge-base>..<head>`. Past 250 commits or an 8 MB patch, `patch`
  is null and the view draws one commit at a time.
- `fetch: false` answers from the object store with `needsFetch`. The
  renderer decides when to fetch (a click, or arrow keys at rest).
- **A fetched head goes to a ref, never a branch.** A same-repository head
  goes to its tracking ref. A fork's head, or one gone from its branch, goes
  to `refs/pwrgit/cr/<remote>/<n>` from the change-request ref.
  - Prune a hidden ref when its number leaves that remote's list, never from
    a truncated list (absence proves nothing). Remove it when its remote is
    removed or renamed.
  - A hidden ref that differs from the forge's `headOid` answers
    `needsFetch`, never a stale `ready`.
- **Local and forge are two ends.** If the local branch and `headOid` differ,
  `relation` says how (`rev-list --left-right`) and the newer end is drawn;
  `show` overrides. The forge end is read from the tracking ref if it
  matches, else fetched only on `show: "forge"` with `fetch`. A
  same-repository fetch goes to the tracking ref, so + Worktree starts from
  the head just shown.
- Only a fetch into `refs/remotes` re-indexes and announces
  `pr:openChanged`, because a row's location can move. A hidden ref is no
  row's location. Main announces before it answers, so the view counts its
  in-flight fetches to ignore the echo.
