# GitHub commit-author identity

PwrGit can enrich a local Git commit author with a GitHub login and avatar only
after proving the mapping against that exact GitHub commit. This is a
main-process service with a typed command/event contract; the lineage context
card remains responsible for rendering the local Git identity as its source of
truth.

## Who decides when to ask

Nothing a renderer does reaches GitHub. Hovering a row, opening a card, or
reloading the graph only reads caches. The main process's people store
(`apps/desktop/src/main/github/commit-author-people.ts`) is the one caller that
may ask the forge, and it does so on its own clock.

A window registers the authors it shows and gets back what main already knows
about each, keyed by `commitAuthorPersonKey(email)`:

```ts
const known = await dispatch("people:replaceInterest", {
  worktreeId,
  monitorId, // one per surface; replaced on every call
  authors: [{ name, email, commitHashes /* their newest, newest first */ }]
});
```

The answer is a cache read. Anything learned later arrives as a targeted
`people:changed { worktreeId, people }` delta. An empty `authors` list withdraws
the interest; closing the window withdraws all of it.

```ts
type CommitAuthorPerson = {
  state: "proven" | "none" | "pending" | "unsupported";
  identity?: { login: string; avatarUrl?: string }; // only when proven
  profileUrl?: string; // https, built by main from the proven login
  forge?: "github" | "gitlab" | "gitcafe";
  checkedAt?: number;
};
```

The store's schedule:

- A newly registered author waits two seconds before their first visit, so
  flicking through graphs does not trigger anything.
- Each tick visits at most four authors. Ticks are at least 15 seconds apart.
- A visit asks the identity service with network allowed. The service still
  calls the forge only when its persisted TTL or backoff says the answer is
  due. A settled author is visited again after six hours, which is a local read
  until a TTL below runs out.
- A visit that leaves an author unsettled backs off: 10 minutes, doubling up to
  six hours. When the forge could not see that commit, the next visit tries the
  author's next one.
- Registering again, from any number of windows, never moves a visit earlier.
  The schedule outlives a window closing and reopening.

`github:hydrateCommitAuthorIdentities` is also a plain cache read of exact
commits, for surfaces such as file history that show per-commit authors. It
never starts a refresh.

`identity.avatarUrl`, when present, is a renderer-safe, versioned
`pwrgit-avatar://thumbnail/<opaque-key>?v=<fetched-at>` URL for PwrGit's local
thumbnail file. It is never GitHub's remote avatar source URL or a filesystem
path. The main process serves only an existing opaque cache key with its
recorded MIME type and size; the response is cacheable by Chromium. Its version
changes after a successful refresh, so a card keeps the old local image until a
new local image is ready.

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
SQLite or disk. It exposes a versioned, opaque local resource to the renderer,
never a local path, remote source URL, or credential-bearing URL.

Every lookup validates the worktree origin before using an exact proof. A
local lookup (`cacheOnly: true`) then reads only SQLite and the thumbnail
index. However stale a row is, it reports the row as stale (`cacheState`,
`avatarCache`) and starts nothing. A network lookup revalidates a stale or
missing proof and downloads a missing or stale thumbnail, and waits for both
before it settles. Only the people store makes network lookups.

Both exact-commit revalidations and avatar downloads have an internal
two-at-a-time queue, under the store's own per-tick bound.

A forge that cannot prove commit authors (GitCafe) is not eligible. It is
never asked and gets no backoff row.

`fetched_at` is the last successful remote refresh; `last_accessed_at` is
touched at most once an hour per row to avoid SQLite write churn during pointer
movement. `refreshedAt` and `nextRetryAt` project the relevant proof timestamps
to the people store, which reads them to decide when its next visit is worth
making. They are persisted, so a restart does not reset them.

| Outcome | Cache behavior |
| --- | --- |
| Verified login | Fresh for 7 days; stale verified data remains usable during refresh |
| Exact commit with no GitHub account | Negative-cached for 24 hours |
| Git, `gh`, authentication, permission, network, malformed, or mismatch failure | Back off from 1 minute exponentially to 1 hour |
| Avatar thumbnail | Local 64px file fresh for 30 days; a stale file stays on screen until the store's next visit replaces it |

The identity service has no timer of its own. The people store's schedule,
above, is the only thing that starts an attempt. Cache cleanup keeps identity rows
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
