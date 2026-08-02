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
};
```

When origin validation, a proof-scoped cache read, or a background verification
settles, main emits
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

## Cache and failure behavior

The persistent SQLite table is `github_commit_author_identity_cache`. Its key
is a versioned SHA-256 of the normalized local name/email plus the proven
GitHub owner, repository, and full commit SHA. The service never reads a row
until it has revalidated that worktree origin and SHA. It stores only that
opaque key, GitHub login/avatar, timestamps, status, and retry metadata—never
raw author fields, remote output, or credentials.

| Outcome | Cache behavior |
| --- | --- |
| Verified login/avatar | Fresh for 7 days; stale verified data remains usable during refresh |
| Exact commit with no GitHub account | Negative-cached for 24 hours |
| Git, `gh`, authentication, permission, network, malformed, or mismatch failure | Back off from 1 minute exponentially to 1 hour |

There is no poller or retry timer. A later context-card request after the gate
expires starts the next best-effort attempt. Cache cleanup retains stale proven
mappings for 90 days after expiry, negative rows for 7 days, and unavailable
rows for 1 day.

## Credential boundary

`GhCliCommitAuthorIdentityTransport` uses `gh api --hostname github.com` and
lets the GitHub CLI use its own configured credential store. It does not call
`gh auth token`, read `GITHUB_TOKEN`, accept a token parameter, persist a token,
or send credentials through IPC. PwrGit shares only the CLI PATH/execution
helper with the existing PR client; its GraphQL token flow remains separate
because an identity lookup is a single exact-commit REST proof rather than a
batched PR-status query.
