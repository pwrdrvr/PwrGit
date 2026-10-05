# github — AGENTS.md

Bulk change-request status for local branches (including non-worktree refs
needed by the lineage graph). Best-effort: silently no-ops when no provider
claims `origin`'s host, the CLI isn't logged in, or the network fails.

- **`PrService` is forge-agnostic** — see `../forge/AGENTS.md`. It resolves one
  `ForgeProvider` per call from `origin` and speaks only `PrSummary`, so GitLab
  merge requests use the same cache, deltas, and TTLs as GitHub pull requests.
  Everything below describes the GitHub provider's half.
- **`../forge/github/repo-provider.ts` answers the clone/fork dialogs** — a
  different seam from PR status, see `../forge/AGENTS.md`. `gh repo list --json`
  for catalogs (it carries `visibility`, `isFork` and `parent`), and
  `gh api repos/{nwo}` for one repository — REST is the only GitHub response
  carrying `source`, the fork-network root, alongside `parent`. `fork()` reads
  the result back, which makes "created" and "already exists" one path.
- **Auth**: `getGitHubToken(host)` takes the host it is about to query and
  runs `gh auth token --hostname <host>` (reuses the user's gh login — no
  separate flow). Cached ~5 min, **keyed by host**: a single-slot cache hands
  one host's token to another for the rest of the TTL.
  `GITHUB_TOKEN` applies to **github.com only** — it is a github.com PAT by
  every convention that sets it, and sending it to a self-managed Enterprise
  host would hand that server a credential for an unrelated forge. `gh` draws
  the same line with a separate `GH_ENTERPRISE_TOKEN`.
- **Enterprise endpoints**: `githubGraphqlBaseUrl(repo)` builds the GraphQL
  base from `forgeOrigin` — the same helper the GitLab client uses — so a
  remote that named a non-default web port keeps it. github.com returns
  undefined so Octokit's own default stands rather than being restated.
- **`gh-cli.ts` is a thin binding** over the shared, audited spawner in
  `../forge/cli-runner.ts`; it holds GitHub's vocabulary (binary, token shapes,
  sensitive env names) and nothing else. Its test still covers the runner.
- **Bulk query**: `pr-query.ts` builds ONE GraphQL query per ~50 branches via
  aliased `pullRequests(headRefName: $bN)` — so 100 branches ≈ 2 requests, not
  100. Matching by `headRefName` (not the live ref) still finds PRs whose branch
  was deleted after a squash/merge.
- **Backoff**: `pr-client.ts` wraps `@octokit/graphql` (ESM — named import is
  fine) with Retry-After / rate-limit-reset respect + exponential backoff
  (ghcrawl's semantics, without the `bottleneck`-based octokit plugins that a
  git-hosted transitive dep made uninstallable here). The decision itself is
  `../forge/retry.ts`, shared with GitLab; this file keeps only the adapter
  that reads status and headers off GitHub's two error shapes.
  - **The second shape is the trap.** GraphQL answers a spent rate limit with
    **HTTP 200** and an `errors` entry, which `@octokit/graphql` raises as a
    `GraphqlResponseError` — the same class a missing repo arrives as. It has
    no status, and its headers hang off the error itself (`response` there is
    the GraphQL body), so the adapter reads it as the 429 it means.
  - **Check the container, not `data`.** GraphQL nulls the erroring *field*, so
    a refusal answers `{"data":{"repository":null},"errors":[…]}` — `data` is an
    object, and salvaging it maps every alias to "no PR". `repositoryResolved`
    (`pr-query.ts`) is the test both the success and the failure path apply; see
    "A refusal is not an answer" in `../forge/AGENTS.md` for why.
- **Cache + bus**: `PrService` upserts `branch_pr` (repo+branch, negative-cached)
  and returns the *changed* branches; `pr:refresh` (TTL-throttled 10 min unless
  `force`) emits a targeted `pr:changed { repoId, prs }` delta the renderer
  patches onto the tree in place — no full `repo:list` reload. `listRepos` also
  LEFT JOINs `branch_pr` onto `Worktree.pr` for the initial load.
  - **A refresh that could not finish is throttled by `lastFailedAt`, not by
    the cache.** It writes no row, so `fetched_at` — and therefore `isFresh` —
    cannot hold the retry back. The check sits above `branchesToCheck`, so a
    throttled refresh costs no `git for-each-ref` either. See "Never
    negative-cache a failure, but do remember that you tried" in
    `../forge/AGENTS.md` for why it is keyed by scope rather than by repo.
- **Commit PR monitoring**: exact visible SHAs are association-cached in
  `commit_pr`; never enroll an entire history window. Renderers debounce one
  atomic visible-set replacement. Main keeps unknown visible associations in a
  SHA monitor, moves discoveries into the shared repo+PR-number monitor, and
  unions commit-list and selected-worktree reasons before polling.
  GitHub can return an upstream PR when asked about a fork's inherited commit:
  preserve the PR node's `repository.nameWithOwner`. Status refresh groups the
  cached identities by repository path and applies each answer only to matching
  rows; a fork's `#3` and upstream's `#3` are independent PRs.
- **Commit-author identity**: the service only fetches an exact full commit
  SHA from a recognized forge `origin`. It accepts a
  login/avatar only after SHA + local Git author name/email match. Exact proof
  normally comes from GitHub's commit `author`; when that field is null, a
  unique PR associated with that exact SHA may supply the account only if its
  login matches the Git author name or email local part. The exact proof and a
  conflict-safe hashed email→account association live in SQLite, so another
  GitHub commit by the same proven author paints immediately across repos.
  64px avatar bytes are deduplicated on disk under
  `userData/cache/github-avatar-thumbnails`, with fetch/access timestamps. IPC
  exposes only a versioned local `pwrgit-avatar://` URL, never the source URL
  or path; its protocol handler reads just the opaque local thumbnail and lets
  Chromium cache it. Its `gh api` transport deliberately does not share the PR
  client's token-extraction flow. GitLab's half of this lives in
  `../forge/gitlab/commit-author-transport.ts`.
- **Only the people store asks a forge about an author**
  (`commit-author-people.ts`). Renderers register who they show with
  `people:replaceInterest` and get cached answers back; the store visits a few
  authors per tick on its own clock and pushes `people:changed`.
  `cacheOnly` lookups (the registration read, `github:hydrateCommitAuthorIdentities`)
  are strictly local: no forge call and no thumbnail download, however stale
  the row. There used to be a hover command that revalidated on demand. Don't
  bring one back: a sweep down a history column would become a burst of API
  calls, and "the user hovered" is not a reason to spend rate limit. If a
  surface needs fresher data, change the store's schedule. Registering again
  must never move a visit earlier. The store's tests pin that.
- **Commit-author identity is forge-wide** — see `../forge/AGENTS.md`. The
  service keeps its historical `GitHub*` names and hydrate channel, but resolves
  any recognized `origin` and routes to that forge's credential-opaque
  transport. A forge whose product says `commitAuthorIdentity: false` is not
  eligible and is never asked.
- **`OpenPrService` holds each repository's open change requests**
  (`repo_open_pr`, migration 0032) — the list the refs browser's Pull requests
  tab and ⌘K search read, and the only cache that knows a PR whose head was
  never fetched. Same shape as `PrService`, deliberately separate state: its
  own TTLs (10 min on the repo-expand sweep, 60 s when the refs browser opens),
  its own `lastFailure`, its own generation guard. Reads never wait on a
  forge: `pr:openList` answers from the table and re-lists behind it,
  announcing `pr:openChanged` whenever a refresh ran — rows, `fetchedAt` and
  `failure` are all part of the answer (the sidebar shows how old the list is
  and why it is not newer). Rows are still diff-written, so an unchanged list
  re-indexes nothing.
  - **One list per forge repository, not per checkout** (migration 0039).
    Every remote a product claims is asked, deduplicated by `forgeRepoKey`
    (`host/path`, lowercased) and named after its first remote, `origin`
    first. A fork checkout's `origin` is your own repository; the PR you
    sent to the original is only on `upstream`'s list. Rows are keyed
    `(repo_id, forge_repo, number)` because the fork's #14 and the
    original's #14 are different PRs, and `repo_open_pr_state` has one row
    per forge repository, so each list refreshes and fails on its own.
    A remote whose host has no sign-in is left out quietly (`unasked`) —
    except the first forge remote (`origin` when there is one), whose missing
    sign-in is reported. A refresh drops the rows of a forge repository no
    remote points at any more — but never when `git remote -v` failed, which
    is "unknown", not "none".
  - **A head is looked for on the remote whose repository holds it**
    (`ChangeRequestPlace`). Usually that is the listing remote. When a fork's
    head is in a repository this checkout *also* has a remote on — your fork,
    for a PR you sent upstream — it is that remote, so the PR lands in Local
    on your own branch. Any other fork's head is the numbered branch, which
    names its remote off `origin`: `pr/upstream/405`, so two lists' #405
    never share one branch.
  - **`list()` spawns nothing in the common case.** The sidebar calls it on
    every repo expand and every announcement, so heads are located against
    the branch index (`local_branches`, `remote_branches`, `worktrees` — the
    same tables ⌘K resolves PRs with), and `origin`'s URL is re-read only when
    `.git/config` changes (all remotes' URLs, one `git remote -v`, which
    applies `insteadOf` the way `git remote get-url` did). The index can trail a terminal's fetch, so a label
    may lag; the verbs never do — the renderer's `reachableLocation` sends
    every non-worktree row through `pr:fetchHead`, which locates with git.
  - **Every row is indexed** (`change_request` in `search_fts`, by trigger,
    under the row's integer `id`), and
    `RepoIndexer.searchAll` answers a hit on one with the worktree, local branch
    or origin branch holding its head — carrying the PR — so ⌘K returns the
    thing to act on. Only a head nothing here holds comes back as a
    `change_request` hit, and Enter on it runs `pr:fetchHead` first.
  - **`fetchHead` never overwrites a branch.** An unfetched same-repository head
    is fetched into `refs/remotes/origin/<head>` (forced — it is a tracking
    ref); a fork's into `pr/N` *without* `+`, with `branch.pr/N.merge` set to
    the forge's change-request ref so a later pull follows the PR. A head
    already here is returned as-is. Forge-supplied names reach a refspec only
    after `git check-ref-format --branch`.
  - A number the list does not hold (merged, closed, or opened since) is asked
    of `fetchPrsByNumbers` once and remembered for five minutes; an omitted
    answer is not remembered.
  - **`pr:view` reads a change request with no worktree and no forge call**
    (the sidebar's PR view). Diff and commits come from git alone:
    `git diff -M <merge-base> <head>` and `git log <merge-base>..<head>`
    (250 commits, an 8 MB patch — past that `patch` is null and the view
    draws commits one at a time). `fetch: false` answers from the object
    store and says `needsFetch` rather than fetching; the renderer decides
    when a fetch is wanted (a click, or arrow keys resting).
    - **A fetched head goes to a ref, never a branch.** A same-repository
      head goes to its tracking ref, as `fetchHead` does. A fork's head, or
      one gone from its branch, goes to `refs/pwrgit/cr/<remote>/<n>` from
      the forge's change-request ref. A hidden ref there is pruned when its
      number leaves that remote's list — never from a truncated list, where
      absent proves nothing.
    - **Local and forge are two ends.** When the branch here and the forge's
      `headOid` differ, `relation` says how (`rev-list --left-right`) and the
      newer end is drawn; `show` overrides. The forge's end is read from the
      head's tracking ref when that matches, else fetched only on
      `show: "forge"` with `fetch`.
    - A fetch announces `pr:openChanged` (the row's location moved), and the
      view ignores its own echo.
- A **merged PR** makes a branch prunable at any age (`isPrunableWorktree`) —
  catches squash/rebase merges the git-ancestry "in default" check can't see.
