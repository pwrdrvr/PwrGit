# GitHub commit-author identity

PwrGit can enrich a local Git commit author with a GitHub login and avatar only
after proving the mapping against that exact GitHub commit. This is a
main-process service with a typed command/event contract; the lineage context
card remains responsible for rendering the local Git identity as its source of
truth.

## Renderer contract

The shared command is non-blocking and never waits for GitHub networking. It
first validates the worktree's GitHub `origin` in the background, because the
persistent cache is scoped to that exact origin and full commit SHA:

```ts
const result = await dispatch("github:commitAuthorIdentity", {
  worktreeId,
  commitHash: commit.hash,
  authorName: commit.authorName,
  authorEmail: commit.authorEmail
});

if (result.ok && result.value.identity !== undefined) {
  contextCard.setGitHubIdentity(result.value.identity);
}
```

The command returns this presentation-neutral value immediately:

```ts
type GitHubCommitAuthorIdentityLookup = {
  identity?: { login: string; avatarUrl?: string };
  cacheState: "fresh" | "stale" | "miss";
  refreshState: "idle" | "in-flight" | "backing-off" | "not-eligible";
  refreshedAt?: number;
  nextRetryAt?: number;
  avatarCache?: {
    cacheState: "stale" | "miss";
    refreshState: "in-flight" | "backing-off";
    refreshedAt?: number;
    nextRetryAt?: number;
  };
};
```

`identity.avatarUrl`, when present, is a renderer-safe `data:image/...` URL
made from PwrGit's local thumbnail file. It is never GitHub's remote avatar
source URL. A cached login may arrive before its thumbnail; the same targeted
event then carries the local thumbnail after its best-effort disk/network work
settles. Consumers should reserve the avatar's dimensions and keep rendering
the local Git author while either field is absent. `avatarCache` is present
only while a proven thumbnail is stale, missing, or backing off; a later hover
should use its retry timestamp without re-fetching a fresh identity on every
pointer move.

When origin validation, a proof-scoped cache read, a thumbnail read, or a
background verification settles, main emits
`github:commitAuthorIdentityChanged` with the same lookup plus the worktree ID
and commit hash. A card can subscribe to that event and repaint only if it is
still showing that commit. It must not delay opening or replace the local Git
name/email while resolution is pending or absent.

## Reliability rule

PwrGit starts a first lookup only when all of these conditions hold:

- the local author name and email are valid;
- the selected worktree has an `origin` remote recognized as `github.com`; and
- the commit hash is a full 40-character SHA, not a branch, tag, short SHA, or
  an email/name lookup.

The background service runs `git remote get-url origin`, then requests only:

```text
GET /repos/{owner}/{repo}/commits/{commitSha}
```

It accepts a login/avatar only when the returned SHA equals the supplied SHA,
the returned Git commit author name and normalized email equal PwrGit's local
commit data, and GitHub returned `author.login`. A response that has no GitHub
account (`author: null`) after those checks is an explicit no-match. A malformed
response, SHA/author mismatch, missing `gh`, bad auth, missing permission, or
network failure is inconclusive rather than negative.

## Persistent caches and refresh behavior

The exact-proof table is `github_commit_author_identity_cache`. Its key is a
versioned SHA-256 of the normalized local name/email plus the proven GitHub
owner, repository, and full commit SHA. The service never reads a row until it
has revalidated that worktree origin and SHA. It stores only that opaque key,
GitHub login, avatar *source* URL, timestamps, status, and retry metadata—never
raw author fields or credentials.

`github_avatar_thumbnail_cache` is a second SQLite index keyed by a SHA-256 of
the normalized GitHub avatar endpoint. It records `fetched_at`, `expires_at`,
`last_accessed_at`, byte length, MIME type, and retry metadata. Its matching
64px image bytes live under:

```text
<Electron userData>/cache/github-avatar-thumbnails/<opaque-sha256>
```

The thumbnail index deduplicates a GitHub account's image across any number of
exact commit-proof rows. Only trusted GitHub avatar hosts are accepted; the
main process downloads a bounded (512 KiB) image with no auth header, token,
or cookies. The normalizer keeps only GitHub's public avatar revision (`v`) and
the forced 64px size (`s`), dropping any unexpected query parameters before
SQLite or disk. It passes the cached bytes to the renderer as a data URL, never
a local path or remote source URL.

Every eligible hover validates the worktree origin before using an exact proof.
After that, a fresh cached identity and its local thumbnail require no GitHub
network request. A stale row is returned immediately (including a stale local
thumbnail when available) and starts revalidation in the background; the next
event carries any changed login or thumbnail. This is intentional
stale-while-revalidate behavior, not a relaxation of the exact-commit proof.

`fetched_at` is the last successful remote refresh; `last_accessed_at` is
touched at most once an hour per row to avoid SQLite write churn during pointer
movement. `refreshedAt` and `nextRetryAt` project the relevant proof timestamps
to a renderer consumer: it can retain a stale identity during an in-flight
refresh and retry only after the persisted gate has elapsed. These are
persisted so a later hover, restart, or large-repository session can decide
whether it needs a background refresh.

| Outcome | Cache behavior |
| --- | --- |
| Verified login | Fresh for 7 days; stale verified data remains usable during refresh |
| Exact commit with no GitHub account | Negative-cached for 24 hours |
| Git, `gh`, authentication, permission, network, malformed, or mismatch failure | Back off from 1 minute exponentially to 1 hour |
| Avatar thumbnail | Local 64px file fresh for 30 days; stale file remains displayable while it refreshes |

There is no poller or retry timer. A later context-card request after the gate
expires starts the next best-effort attempt. Cache cleanup keeps identity rows
for 90 days (resolved), 7 days (negative), or 1 day (unavailable) after their
last access; thumbnail files and rows remain for 180 days after their last
access. That makes dozens, hundreds, or thousands of tiny cached avatars cheap
to retain without making them permanent.

## Credential boundary

`GhCliCommitAuthorIdentityTransport` uses `gh api --hostname github.com` and
lets the GitHub CLI use its own configured credential store. It does not call
`gh auth token`, read `GITHUB_TOKEN`, accept a token parameter, persist a token,
or send credentials through IPC. PwrGit shares only the CLI PATH/execution
helper with the existing PR client; its GraphQL token flow remains separate
because an identity lookup is a single exact-commit REST proof rather than a
batched PR-status query.
