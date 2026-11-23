# github — AGENTS.md

Bulk change-request status for local branches, including non-worktree refs
for the lineage graph. Best-effort: it does nothing, silently, when no
provider claims `origin`'s host, the CLI is not logged in, or the network
fails.

## Providers, auth and transport

- **`PrService` is forge-agnostic** (`../forge/AGENTS.md`). Per call it
  resolves one `ForgeProvider` from `origin` and uses only `PrSummary`, so
  GitLab MRs share the cache, deltas and TTLs. This file is GitHub's half.
- **`../forge/github/repo-provider.ts` answers the clone/fork dialogs** (a
  separate seam). Catalogs use `gh repo list --json` (`visibility`, `isFork`,
  `parent`). One repository uses `gh api repos/{nwo}`: only REST carries
  `source` (the fork-network root) with `parent`. `fork()` reads the result
  back, so "created" and "already exists" are one path.
- **Auth.** `getGitHubToken(host)` (`pr-client.ts`) runs
  `gh auth token --hostname <host>`, adding `--user <account>` when the host
  is pinned to an account. The cache (approximately 5 min) is **keyed by host
  and account**; a single slot leaks one token to another. `runGh` gives every
  other spawn for a pinned host that account's token through its environment.
  A stale pin is signed out and never falls back. Read [Host
  accounts](../../../../../docs/guides/main-forge/forge-hosts-and-status.md#host-accounts)
  before changing `gh-account.ts`, `runGh` or the token cache.
- `GITHUB_TOKEN` applies to **github.com only**. It is a github.com PAT, and
  an Enterprise host must not get it. `gh` uses `GH_ENTERPRISE_TOKEN` for the
  same reason.
- **Enterprise endpoints.** `githubGraphqlBaseUrl(repo)` builds the GraphQL
  base from `forgeOrigin` (shared with GitLab), so a non-default web port is
  kept. github.com returns undefined, so Octokit's default applies.
- **`gh-cli.ts` is a thin binding** over the audited spawner
  `../forge/cli-runner.ts`. It holds only GitHub's binary, token shapes and
  sensitive env names. Its test still covers the runner.

## Querying PR status

`pr-query.ts` asks about ~50 branches per GraphQL query, by `headRefName`,
under the published name, filed under the local one. A spent rate limit is
HTTP 200 with an `errors` entry; check the container, not `data`. Read
[the PR status
guide](../../../../../docs/guides/main-github/pr-status.md#querying-pr-status)
before changing
the query, the tip fallback or `pr-client.ts` backoff.

## Cache and events

`PrService` upserts `branch_pr` and emits a `pr:changed` delta of changed
branches. `lastFailedAt` throttles an unfinished refresh; it writes no row.
Read [the PR status
guide](../../../../../docs/guides/main-github/pr-status.md#cache-and-events)
before changing
the cache, throttles or commit PR monitoring.

## Commit-author identity

A match is not proof of authorship: UI says "matched", and only a valid
signature by the linked account reads "verified". Only the people store asks
a forge about an author; don't add hover revalidation. Read
[the commit-author
guide](../../../../../docs/guides/main-github/commit-author-identity.md)
before changing
author matching, avatars or the people store's schedule.

## Open change requests

`OpenPrService` keeps one list per forge repository (`repo_open_pr`), and
reads never wait on a forge. `fetchHead` and `pr:view` never overwrite a
branch. Read [the open change requests
guide](../../../../../docs/guides/main-github/open-change-requests.md)
before changing listing, head location, `fetchHead` or the PR view.

## Branch lifecycle

- **A branch going gone re-asks about its open PR** (`gone-pr-refresh.ts`).
  `WorktreeStateService.onUpstreamGone` fires on each probe that finds the
  upstream gone; `index.ts` queues it only while the cached PR is open. The
  0→1 transition asks at the user tier; a still-gone branch asks at the
  scheduled tier, batched per repo per tick. Without it, a `gone` row kept a
  green open chip for the ten-minute repo sweep.
- A **merged PR** makes a branch prunable at any age (`isPrunableWorktree`),
  catching squash/rebase merges the git-ancestry "in default" check misses.

## Merge queues

GitHub merge queues and GitLab merge trains ride the same PR reads. Shared
`merge-queue.ts` holds `PrMergeQueue` (the forge's answer, stored as JSON in
`merge_queue`, migration 0046) and `mergeQueueStatus`, the one reading of it.

- **Ask in the same request.** If a second query fails, a queued PR gets
  cached as plain green. GHES before 3.8 and GitLab CE refuse the whole
  document over the queue fields. `pr-client.ts`/`mr-client.ts` then ask
  again without them and remember that per host. Absent means "not known".
- **A queue merge ends with a removal.** GitHub writes
  `RemovedFromMergeQueueEvent` with reason `merged` when the queue merges.
  Only any other reason is "removed".
- **Enqueue never merges.** `pr:enqueue` reads the PR first and refuses a
  base with no queue. It then calls `enqueuePullRequest` (GitHub) or the
  merge-train endpoint (GitLab), pinned to the head the user saw. PwrGit has
  no direct-merge verb; don't add a fallback to one.
- `gh-readonly-queue/*` remote refs are filtered in `git-service.ts`
  (`isMergeQueueRemoteRef`). They never reach branch lists, graph labels or
  the index.
- `merge-queue.model.test.ts` drives a model of the queue lifecycle through
  the parser, the column and the mapping. Extend it for any new queue field.
