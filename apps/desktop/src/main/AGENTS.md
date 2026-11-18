# src/main — AGENTS.md

Notes for the main process as a whole. See `apps/desktop/AGENTS.md` for
app-wide build facts, and the nested files (`git/`, `github/`, `forge/`) for
each area.

## Main cannot tell which profile is asking

`CommandContext` carries no profile, so a handler cannot scope a query to the
window that sent it. Scoping exists only where the renderer passes
`profileId` (copy `repo:list`). `emitEvent` goes to every window, so put a
`profileId` on any event whose payload belongs to a profile. If a query is
capped with `LIMIT`, scope it in SQL.
Read [Main-process profile
scoping](../../../../docs/guides/main/profile-scoping.md#main-cannot-tell-which-profile-is-asking)
before adding a handler, event or query that reads profile-owned rows, or
changing ⌘K search.

## Test it with two profiles, or you have not tested it

A query, cache or sweep that reads rows keyed by repo, worktree or branch needs
a test with **two** profiles in the database and the answer asserted against
one of them.
Read [Main-process profile
scoping](../../../../docs/guides/main/profile-scoping.md#test-it-with-two-profiles-or-you-have-not-tested-it)
before writing that test; it names the ones to copy.

## A deferred quit resumes from a macrotask

A `before-quit` or `will-quit` listener that calls `preventDefault()` must
retry `app.quit()` through `retryQuitAfterDispatch` (`quit-retry.ts`), never
straight from the promise chain it waited on. A quit path with its own exit
deadline calls `quitDrain.hurry()` first.
Read [Main-process quit
sequencing](../../../../docs/guides/main/quit-sequencing.md#a-deferred-quit-resumes-from-a-macrotask)
before changing quit, shutdown or `bounded-shutdown.ts`.
