# Forge provider seam and failures

This guide covers the `ForgeProvider` seam, the shared CLI and retry helpers, how forge clients fail without caching a failure, GitLab change-request specifics, and the GitLab test fixture.

## The provider seam

- **The seam is `ForgeProvider`** (`types.ts`), in two shapes:
  - `TokenForgeProvider` (GitHub, GitLab): token, branches, commits, numbers,
    and the open list. `connectForge` binds the token to the other four.
  - `CliForgeProvider` (GitCafe): a `ForgeConnection` with the four reads. It
    authenticates inside each command.
- Token, branches, commits and numbers are the four functions `PrService` used
  to inject, so its body did not change. The open list belongs to
  `OpenPrService`.
- Add a forge by implementing these methods. Do not change either service.
- **The open list (`fetchOpenPrs`) is the one read not keyed by a local ref.**
  So only it finds a change request whose head the checkout never saw: every
  fork's, and any opened since the last fetch. It owes two rules:
  - **A complete walk, or a throw.** `OpenPrService` replaces the stored list
    by diff, so a short answer *deletes* the change requests it left out. Walk
    every page up to `OPEN_PR_LIST_CAP` and set `truncated` past it. Throw on a
    failed page, a repeated cursor, or a null project.
  - **Mark a fork with `headRepoPath`**, in the list AND in
    `fetchPrsByNumbers`. Heads match local branches by name, and a fork's
    `main` is not ours. Without the mark, a merged fork PR offered
    "Show worktree" on the user's own `main`.
  - A fork the forge will not name is `UNAVAILABLE_FORK`. Its head stays
    reachable by `FORGE_PRODUCTS[kind].changeRequestHeadRef`, checked out as
    `changeRequestLocalBranch` (`pr/121`).
- **`ForgeRepo.path` is one string, on purpose.** A GitLab project can live at
  any depth (`pwrdrvr/qa/forge/PwrGit-Test`), so `{owner, repo}` cannot hold
  it. GitHub paths have exactly one slash; `githubOwnerAndName()` splits them
  for GraphQL. Test with a nested repo: a flat one hides a regression.
- **Return an entry for every key requested.** `null` negative-caches a branch
  or commit. An omitted key is refetched forever. `withNullsForMissing()`
  fills the nulls.
  - Omit a key only where the lookup *failed*: a single unreachable commit, or
    a batch the walk never reached. This stops a blip being cached as
    "no change request". `PrService` records the attempt instead (see
    [Failures](#failures)).

## Shared helpers

- **`cli-runner.ts` is the audited `gh`/`glab` process spawner:** no inherited
  TTY, no prompt, bounded output, no credentials in a diagnostic. It is the
  former `gh-cli.ts` body with brand parts moved into a `CliSpec`. Change
  behavior here, not in a copy. `../github/gh-cli.test.ts` must keep passing.
- **`retry.ts` holds the one retry/backoff decision** for every forge client,
  so a fix cannot reach one client and miss another. Its header documents the
  ordering and the non-goals.
  - A forge adds a dialect-table row (header spelling, and every status that
    carries a window) and a short adapter that reads its own error type.
    GitHub reports a spent hourly budget as 403 or 429; GitLab uses only 429.
  - Retry *budgets* stay with the caller. So commit association can use fewer
    attempts than the branch query.
  - `retry.property.test.ts` holds the promises for any response: no wait
    under 1 s or over the ceiling, never undercut a Retry-After or a spent
    reset (decline instead), and one answer for both forges but GitHub's 403.
    It also keeps #225's harness against the pre-#225 policies
    (`test-support/retry-pre-225.ts`): every divergence needs a named reason.
    `retry-clients.property.test.ts` runs the same through both real clients,
    plus #230's kept batches.
  - `Retry-After` is whole seconds. `0.001` read as a number retried four
    times in 5 ms.

## Failures

- **A refusal is not an answer.** Clients negative-cache "no change request"
  from a query result. So a null `repository`/`project` container, or a 200
  that is not our JSON, must throw. Returned, it writes "no PR" on every branch
  in the batch for the refresh TTL. `PrService` treats a thrown refresh as
  best-effort and keeps what it had.
- **A batch that fails keeps the batches before it** (`chunked.ts`, one
  helper). Clients walk keys in chunks of ~50. If the fourth request fails, the
  150 resolved branches still return. Only a failed *first* chunk rethrows.
  - **Only the fetch is inside the `try`.** A parser throw is our bug, not a
    refusal. Swallowed, a `TypeError` becomes a silent short map.
  - **The walk stops at the failing chunk.** A revoked token or complexity cap
    refuses every chunk, so continuing spends the retry budget again per chunk.
  - GitLab's branch query cannot separate fetch from parse (paging needs parsed
    data), so it is the named function `newestMrPerBranch`. An abandoned batch
    contributes nothing; filling its nulls would negative-cache branches whose
    MR is on an unread page.
- **Never negative-cache a failure, but do remember that you tried.** A refusal
  writes no row, so `fetched_at` does not move and nothing throttles the retry.
  A permanently refused query (GHES validation error, complexity cap, revoked
  token) would be re-sent on every repo-row expand, hover and worktree-monitor
  replacement. Callers queued behind an in-flight refresh would each retry.
  `PrService.lastFailedAt` is the in-memory mark, read against the TTL a
  success would have earned. Four properties are load-bearing:
  - **Keyed by scope** (`FailureScope`: whole-repo sweep, targeted refresh,
    commits). A forge that refuses one query shape often answers another. With
    one repo-wide mark, hover failures re-stamp faster than the sweep's ten
    minutes and starve the only refresh that covers every branch.
  - **A mark from the future is ignored.** `Date.now()` is not monotonic. A
    backward clock step would suppress every refresh, and nothing in the
    renderer sends `force`.
  - **Writes are generation-guarded**, so an in-flight refresh cannot re-arm
    what `invalidatePendingWrites` cleared. `forget(repoId)` drops one repo's
    marks, because repo ids are path-derived and reused.
  - **A partial branch answer is a failed attempt.** `isFresh` is
    all-or-nothing, so one omitted branch re-sends every chunk. Resolved chunks
    are still written. Commit freshness is per hash, so only a total failure is
    marked. So `fetchMrsForCommits` **throws** when every SHA failed: an empty
    map would clear the backoff, and the 60s poll would send sixty REST calls
    forever.
  - `refreshPrNumbers` has no mark. Its only caller is `PrStatusMonitor`'s
    fixed 60s timer, so a mark saves at most one request per minute per repo.

## GitLab specifics

Fork, path and group rules are in [gitlab/AGENTS.md](../../../apps/desktop/src/main/forge/gitlab/AGENTS.md). For
change-request status:

- **Batching is native.** `mergeRequests(sourceBranches: [...])` takes a list,
  so one field replaces GitHub's ~50 aliases. The response is flat; we group
  per branch and fill nulls.
- **`iid` is a GraphQL String**, but REST sends a number. Everything goes
  through `toSummary`'s `toNumber`.
- **States are lowercase, with a fourth value.** `locked` (discussion locked)
  maps to `open`; as terminal, it would stop refreshes. `draft` is a boolean;
  never parse a `WIP:` title.
- **Commit association has no batch API:** one REST call per SHA, bounded
  concurrency, capped per refresh. Its retry budget is smaller than the branch
  query's; otherwise an outage over 60 commits backs off for minutes on the
  hover path. The `commit_pr` cache keeps it cheap.
- **No schema migration was needed.** `branch_pr`/`commit_pr` store only the
  forge-agnostic `number/url/title/state/is_draft`.

## Test fixture

- `pwrdrvr/qa/forge/PwrGit-Test` (private, gitlab.com): a nested 4-segment
  path; MRs `!1`–`!6` (opened, draft, closed, merged, squash-merged,
  conflicting); and a branch with no MR.
- The **imported** `pwrdrvr/PwrGit` mirror is *not* a substitute. Its MRs lack
  `merge_commit_sha`/`squash_commit_sha`, so mainline commits resolve to no MR
  and look like a bug here. Use it only for branch→MR at scale.
