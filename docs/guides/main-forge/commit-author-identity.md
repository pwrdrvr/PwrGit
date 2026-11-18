# Hover card, commit-author identity and SSH keys

This guide covers the change-request hover card, forge-wide commit-author identity, and the published SSH server key registry.

Code paths in backticks are relative to [apps/desktop/src/main/forge](../../../apps/desktop/src/main/forge/).

## The hover card

- `PrChip` opens `PrStatusCard` (renderer). It renders only from the
  `PrSummary` in the tree and sends **no** request.
- The lineage byline's `PersonCard` renders from loaded commits and the
  `CommitAuthorPerson` main pushed. Only main's people store
  (`../github/commit-author-people.ts`) asks a forge about an author.
- **Every `PrSummary` field after `isDraft` is optional. Keep it so.** Rows
  cached earlier never gain them, because terminal change requests stop
  refreshing. Absence means "not known" and renders as nothing, never zero. So
  every card section is conditional.

## Commit-author identity

Identity is forge-wide (`commit-author.ts`, `commit-author-transport.ts`).

- **Transports are credential-opaque.** Each delegates auth to its CLI
  (`gh api` / `glab api`) and never extracts a token. So a new forge never
  widens what the identity service sees.
- **GitLab's REST commit response has no linked-account field**, only Git
  trailers. The link is in GraphQL (`project.repository.commit.author`), so the
  GitLab transport uses GraphQL. GitHub's uses GraphQL too, batched
  (`fetchCommits`, 50 per request), because only GraphQL names the signer.
  Pass GraphQL *variables*; never interpolate.
- The tri-state matches GitHub: an account object resolves; `null` is an
  authoritative "no linked account"; an absent/unreadable commit is
  inconclusive and caches nothing.
- **Only GitHub reports a signature** (capability `commitSignatures`).
  GitLab's GraphQL `commit.signature` differs across self-managed versions,
  and one unknown field fails the whole query, so GitLab authors read
  "matched", never "verified", until that is asked for safely.
- `fetchCommits` answers only commits the forge could see; an omitted SHA is
  inconclusive (backoff), never "no account". A null container throws.
- **An older self-managed server may lack a field github.com has**, and
  GraphQL rejects the whole document for it. GitHub's signature and PR-fallback
  selections are optional per host (`graphql-feature-fallback.ts`). A response
  made *only* of schema errors drops the named part for that host, for this
  run, and the request is retried. If no error names a part, every optional
  part is dropped. A rate limit, a refusal, or schema errors mixed with any
  other error never drop anything. Such a host's authors read "matched".
  Reuse it for any new optional GraphQL field.
- **Account ids are GIDs** (`gid://gitlab/User/35145513`). Parse; do not cast.
- **Cache keys are per forge instance:** identity key = kind+host+path;
  email→account key = kind+host. One email is a different person on each
  forge; a global key paints the wrong avatar.
- The associated-change-request fallback (`associatedAuthorMatches`) accepts a
  handle only if it equals the Git author name or email local part. It declines
  more often on GitLab, where usernames rarely match. That is intended.
- **`avatar-source.ts` is the allowlist** for every URL that reaches SQLite,
  the thumbnail cache, or an image request: https only, no credentials, no
  fragment, every query parameter dropped except `v` (GitHub revision) and `d`
  (Gravatar fallback). So no signed or tokenized URL persists. GitHub URLs
  normalize byte-identically to before, so cache keys stay valid. A
  self-managed host is trusted only after `rememberForgeAvatarHost` sees it on a
  real `origin`.

## Published SSH server keys

- `ssh-host-keys.ts` is a separate, per-host `ForgeSshHostKeyProvider`
  registry of server identity keys, never account/deploy keys.
- A provider returns an HTTPS source and full keys, `null` when no source is
  known, or throws when the source cannot be retrieved or parsed.
- Never substitute `ssh-keyscan` for a published source. Never apply SaaS keys
  to another hostname/port.
- GitCafe has no verified publication endpoint. Keep its provider unknown until
  one is documented.
