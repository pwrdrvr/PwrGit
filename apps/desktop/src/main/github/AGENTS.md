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
  `gh auth token --hostname <host>`, reusing the user's gh login. The cache
  (approximately 5 min) is **keyed by host**; a single slot leaks one host's
  token to another.
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

## Commit-author identity

- **Commit-author identity.**
  - Fetch only an exact full SHA from a recognized forge `origin`. Accept a
    login/avatar only after the SHA and the local Git author name/email match.
  - Proof is GitHub's commit `author`. If null, a unique PR for that SHA can
    supply the account, only if its login matches the Git author name or
    email local part.
  - SQLite stores the proof and a conflict-safe hashed email→account
    association, so the author's other commits paint at once in all repos.
  - 64px avatars are deduplicated under
    `userData/cache/github-avatar-thumbnails` with fetch/access timestamps.
    IPC exposes only a versioned local `pwrgit-avatar://` URL, never the
    source URL or path. Its protocol handler reads the opaque thumbnail and
    lets Chromium cache it.
  - Its `gh api` transport intentionally does not share the PR client's
    token flow. GitLab's half: `../forge/gitlab/commit-author-transport.ts`.
- **Only the people store asks a forge about an author**
  (`commit-author-people.ts`). Renderers register who they show with
  `people:replaceInterest` and get cached answers. The store visits a few
  authors per tick on its own clock and pushes `people:changed`.
  - `cacheOnly` lookups (the registration read,
    `github:hydrateCommitAuthorIdentities`) never call a forge or download a
    thumbnail, however stale the row.
  - Do not add on-demand hover revalidation (one was removed): a sweep down a
    history column becomes an API burst. Change the store's schedule instead.
  - Registering again must never move a visit earlier (pinned by tests).
- **Commit-author identity is forge-wide** (`../forge/AGENTS.md`). The
  service keeps its `GitHub*` names and hydrate channel but routes any
  recognized `origin` to that forge's credential-opaque transport. A product
  with `commitAuthorIdentity: false` is never asked.

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

## Branch lifecycle

- **A branch going gone re-asks about its open PR** (`gone-pr-refresh.ts`).
  `WorktreeStateService.onUpstreamGone` fires on each probe that finds the
  upstream gone; `index.ts` queues it only while the cached PR is open. The
  0→1 transition asks at the user tier; a still-gone branch asks at the
  scheduled tier, batched per repo per tick. Without it, a `gone` row kept a
  green open chip for the ten-minute repo sweep.
- A **merged PR** makes a branch prunable at any age (`isPrunableWorktree`),
  catching squash/rebase merges the git-ancestry "in default" check misses.
