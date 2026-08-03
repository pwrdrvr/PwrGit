# github — AGENTS.md

Bulk GitHub PR status for worktree branches. Best-effort: silently no-ops when
origin isn't github.com, `gh` isn't logged in, or the network fails.

- **Auth**: `getGitHubToken()` prefers `GITHUB_TOKEN`, else `gh auth token`
  (reuses the user's gh login — no separate flow). Cached ~5 min.
- **Bulk query**: `pr-query.ts` builds ONE GraphQL query per ~50 branches via
  aliased `pullRequests(headRefName: $bN)` — so 100 branches ≈ 2 requests, not
  100. Matching by `headRefName` (not the live ref) still finds PRs whose branch
  was deleted after a squash/merge.
- **Backoff**: `pr-client.ts` wraps `@octokit/graphql` (ESM — named import is
  fine) with Retry-After / rate-limit-reset respect + exponential backoff
  (ghcrawl's semantics, without the `bottleneck`-based octokit plugins that a
  git-hosted transitive dep made uninstallable here).
- **Cache + bus**: `PrService` upserts `branch_pr` (repo+branch, negative-cached)
  and returns the *changed* branches; `pr:refresh` (TTL-throttled 10 min unless
  `force`) emits a targeted `pr:changed { repoId, prs }` delta the renderer
  patches onto the tree in place — no full `repo:list` reload. `listRepos` also
  LEFT JOINs `branch_pr` onto `Worktree.pr` for the initial load.
- **Commit-author identity**: `github:commitAuthorIdentity` only fetches an
  exact full commit SHA from a recognized GitHub `origin`; its cache is scoped
  to that origin and SHA and is read only after validating them. It accepts a
  login/avatar only after SHA + local Git author name/email match. Exact proof
  normally comes from GitHub's commit `author`; when that field is null, a
  unique PR associated with that exact SHA may supply the account only if its
  login matches the Git author name or email local part. Exact proof
  metadata lives in SQLite; 64px avatar bytes are deduplicated on disk under
  `userData/cache/github-avatar-thumbnails`, with fetch/access timestamps and
  stale-while-revalidate on hover. IPC exposes only a versioned local
  `pwrgit-avatar://` URL, never the source URL or path; its protocol handler
  reads just the opaque local thumbnail and lets Chromium cache it. A
  `cacheOnly` request may warm already-proven identities without GitHub calls.
  Graph load batches those reads before publishing interactive rows, coalesces
  origin validation, and decodes available local thumbnails before first hover.
  Stale proof and thumbnail refreshes are internally queued two at a time. Use
  its update event to repaint a card, never to block hover. Its `gh api`
  transport deliberately does not share the PR client's token-extraction flow.
- A **merged PR** makes a branch prunable at any age (`isPrunableWorktree`) —
  catches squash/rebase merges the git-ancestry "in default" check can't see.
