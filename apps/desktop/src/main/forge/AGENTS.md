# forge — AGENTS.md

Which hosting product a repo's `origin` points at, and how to ask it for
change-request status. `PrService` (in `../github/`) is the only consumer; it
speaks `PrSummary` and never learns which forge answered.

- **The seam is `ForgeProvider`** (`types.ts`): four methods — token, branches,
  commits, numbers. That is exactly what `PrService` used to inject as four
  loose functions, which is why the service body did not change. Add a forge by
  implementing those four, not by touching the service.
- **`ForgeRepo.path` is one string, deliberately.** A GitLab project can live at
  any depth (`pwrdrvr/qa/forge/PwrGit-Test`), so `{owner, repo}` cannot hold it.
  GitHub paths are always exactly one slash and `githubOwnerAndName()` splits
  them back for GraphQL. A flat test repo will hide a regression here — use a
  nested one.
- **Return an entry for every key requested.** An explicit `null` is what makes
  a branch or commit negative-cache; omitting the key makes the service refetch
  it forever. `withNullsForMissing()` does this. The one deliberate exception is
  a *failed* commit lookup, which is omitted so a network blip is not cached as
  "no MR".
- **Host detection can't be certain** (`resolve.ts`). The two SaaS hostnames and
  a `gitlab.*` prefix are all we can know; anything else needs an explicit
  override, and until then resolution returns null and the feature no-ops —
  the same best-effort behavior as before this module existed.
- **`cli-runner.ts` is the audited `gh`/`glab` process spawner** — no inherited
  TTY, no prompt, bounded output, and credentials never reaching a diagnostic.
  It is `gh-cli.ts`'s former body with the brand-specific parts lifted into a
  `CliSpec`. Change behavior here, not in a copy; `../github/gh-cli.test.ts`
  covers it and must keep passing.

## GitLab specifics

- **Batching is native, not aliased.** `mergeRequests(sourceBranches: [...])`
  takes a list, so one field replaces GitHub's ~50 aliases. The response is a
  flat list, so grouping per branch and filling nulls are ours to do.
- **`iid` arrives as a GraphQL String** even though it is an integer, while REST
  sends a number. Everything goes through `toSummary`'s `toNumber`.
- **State vocabulary is lowercase and has a fourth value.** `locked` is a live
  MR with discussion locked and maps to `open`; treating it as terminal would
  stop refreshes. `draft` is a real boolean — never parse a `WIP:` title.
- **Commit association has no batch API.** One REST call per SHA at bounded
  concurrency, capped per refresh, with a smaller retry budget than the branch
  query — otherwise an outage over 60 commits backs off for minutes on the
  hover path. The `commit_pr` cache is what keeps this cheap.
- **No schema migration was needed.** `branch_pr`/`commit_pr` already store only
  `number/url/title/state/is_draft`, which is forge-agnostic.

## Status, capabilities, and who may call a forge

- **Only main talks to a forge.** The renderer asks over the bus (`pr:refresh`,
  `forge:status`) and renders from what main pushes back (`pr:changed`,
  `forge:statusChanged`). `renderer-does-not-call-forge-apis` in
  `.dependency-cruiser.cjs` enforces the SDK half of that; a raw `fetch` to a
  forge would still slip through, so it is also a review rule. The reason is
  React StrictMode: every effect runs twice in dev, so one careless `useEffect`
  is two calls per mount per chip, and a sweep across a commit list becomes a
  burst that gets rate limited.
- **`forge:status` has one consumer: Settings → Forges** (`ForgesSettings.tsx`),
  which is the point of the channel — it names the exact command that unblocks a
  signed-out or missing CLI, and lists capabilities so a feature this forge
  cannot do reads as a known limit rather than a bug. A channel with no consumer
  is how the `github:status` it replaced ended up dead.
- **`forge:status` is answered from a cached probe** (`status.ts`). Probing
  spawns a subprocess, so the cache is the point — repeat reads collapse onto
  one value and one in-flight promise. A broken forge re-probes sooner than a
  healthy one, and listeners are woken only when availability actually changed,
  never merely because someone asked.
- **Capabilities describe the integration, not a login** (`capabilities.ts`), so
  they are static per forge and need no network call. `batchedCommitAssociation`
  is false for GitLab because it has no batch endpoint; callers use that to
  avoid asking rather than to handle a failure.

## The hover card

`PrChip` opens `PrStatusCard` (renderer, beside the chip). It renders purely
from the `PrSummary` already in the tree and issues **no** request of its own.

Everything past `isDraft` on `PrSummary` is optional and must stay that way: a
row cached before those fields existed will never gain them, because a change
request that reached a terminal state stops being refreshed. Absence means "not
known" and renders as nothing — never as zero, which is a stronger claim we
have no evidence for. Every section of the card is conditional for that reason.

## Commit-author identity

Identity is forge-wide too (`commit-author.ts`, `commit-author-transport.ts`).
Both transports stay **credential-opaque**: each delegates auth to its own CLI
(`gh api` / `glab api`) rather than extracting a token, so adding a forge never
widens what the identity service can see.

- **GitLab's REST commit response has no linked-account field at all** — only
  raw Git trailers. The link exists only in GraphQL, as
  `project.repository.commit.author`, which is why the GitLab transport speaks
  GraphQL where the GitHub one speaks REST. Values go as GraphQL *variables*,
  never interpolated into the query.
- The tri-state matches GitHub exactly: an account object resolves, `null` is
  an authoritative "no linked account", and an absent/unreadable commit is
  inconclusive and caches nothing.
- **Account ids are GIDs** (`gid://gitlab/User/35145513`) — parse, don't cast.
- **Cache keys are scoped per forge instance.** The identity key carries
  kind+host+path, and the reusable email→account key carries kind+host. The
  same email is a different person on github.com than on a GitLab instance, so
  a global key would paint one forge's avatar onto the other's commits.
- The associated-change-request fallback is guarded identically on both forges
  (`associatedAuthorMatches`): a handle is accepted only if it equals the Git
  author name or the email local part. It declines far more often on GitLab,
  where usernames rarely resemble either — that is the intended failure mode.
- **`avatar-source.ts` is the allowlist** for every URL that may reach SQLite,
  the on-disk thumbnail cache, or an image request. https only, no credentials,
  no fragment, and every query parameter dropped except `v` (GitHub revision)
  and `d` (Gravatar fallback image) — so a signed or tokenized URL can never be
  persisted. GitHub URLs normalize byte-identically to before, so existing
  thumbnail cache keys stay valid. A self-managed host becomes trusted only
  once `rememberForgeAvatarHost` has seen it on a real `origin`.

## Test fixture

`pwrdrvr/qa/forge/PwrGit-Test` (private, gitlab.com) exists to exercise this:
a deliberately nested 4-segment path, plus MRs `!1`–`!6` covering opened, draft,
closed, merged, squash-merged, and conflicting, and a branch with no MR at all.

Note that the **imported** `pwrdrvr/PwrGit` mirror is *not* a substitute: its
MRs carry no `merge_commit_sha`/`squash_commit_sha`, so mainline commits there
resolve to no MR and would look like a bug in this code. Use it only for
branch→MR at scale.
