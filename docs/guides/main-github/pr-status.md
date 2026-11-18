# Change-request status queries and cache

This guide covers how `PrService` queries GitHub for branch PR status, its backoff, and its cache and events. Code paths in backticks are relative to [apps/desktop/src/main/github](../../../apps/desktop/src/main/github/AGENTS.md).

## Querying PR status

- **Bulk query.** `pr-query.ts` builds ONE GraphQL query per approximately 50
  branches (aliased `pullRequests(headRefName: $bN)`), so 100 branches cost
  approximately 2 requests.
  - Match by `headRefName`, not the live ref, to find PRs whose branch was
    deleted after a squash/merge.
  - Candidates carry source-repository identity. They match only `origin` or
    a configured fetch remote on the same GitHub instance.
  - Page past foreign heads. Omit an unfinished walk; never negative-cache it.
  - Exact-commit association is independent and can return upstream PRs.
- **Ask by the published name, file under the local one.** A branch that
  tracks a branch on an accepted source remote (`local-name` →
  `origin/remote-name`) is asked about as `remote-name`. `branchesToCheck`'s
  one `for-each-ref` carries tip and upstream. The answer is keyed back to the
  local name, so `branch_pr`, `isFresh`, failure marks and `Worktree.pr` never
  see the published one.
- **A branch with no upstream falls back to its tip.** When its name finds
  nothing, its tip's exact SHA goes through the commit path (`commit_pr`, its
  TTL and throttle, at most `TIP_FALLBACK_LIMIT` per refresh). The answer is
  kept only if its `headOid` IS the tip. Commit rows written this way are
  announced through `onCommitsChanged`; a silent write would stop the
  visible-commit monitor polling a hash the renderer never heard about.
- **Backoff.** `pr-client.ts` wraps `@octokit/graphql` (ESM; a named import
  is correct). It obeys Retry-After and rate-limit-reset with exponential
  backoff (ghcrawl's semantics).
  - Do not use the `bottleneck`-based octokit plugins: a git-hosted transitive
    dependency made them uninstallable.
  - The retry decision is `../forge/retry.ts`, shared with GitLab. This file
    has only the adapter for GitHub's two error shapes.
  - **The second shape is the trap.** A spent GraphQL rate limit is
    **HTTP 200** with an `errors` entry. It arrives as `GraphqlResponseError`,
    the same class as a missing repo, with no status and headers on the error
    (`response` is the GraphQL body). The adapter reads it as a 429.
  - **Check the container, not `data`.** A refusal is
    `{"data":{"repository":null},"errors":[…]}`. `data` is an object, and using
    it maps every alias to "no PR". Both paths apply `repositoryResolved`
    (`pr-query.ts`). See "A refusal is not an answer" in `../forge/AGENTS.md`.

## Cache and events

- **Cache + bus.** `PrService` upserts `branch_pr` (repo+branch,
  negative-cached) and returns the *changed* branches. `pr:refresh`
  (throttled 10 min unless `force`) emits a `pr:changed { repoId, prs }`
  delta that the renderer patches in place, with no `repo:list` reload.
  `listRepos` LEFT JOINs `branch_pr` onto `Worktree.pr` for the first load.
- **`lastFailedAt` throttles an unfinished refresh, not the cache.** It
  writes no row, so `fetched_at`/`isFresh` cannot delay the retry. The check
  is above `branchesToCheck`, so a throttled refresh runs no
  `git for-each-ref`. It is keyed by scope, not repo: see "Never
  negative-cache a failure, but do remember that you tried" in
  `../forge/AGENTS.md`.
- **Commit PR monitoring.** Association-cache exact visible SHAs in
  `commit_pr`; never enroll a full history window. Renderers debounce one
  atomic visible-set replacement. Main keeps unknown associations in a SHA
  monitor, moves discoveries to the shared repo+PR-number monitor, and unions
  commit-list and selected-worktree reasons before polling.
- GitHub can return an upstream PR for a fork's inherited commit. Preserve
  the PR node's `repository.nameWithOwner`. Status refresh groups cached
  identities by repository path and applies answers only to matching rows: a
  fork's `#3` is not upstream's `#3`.
