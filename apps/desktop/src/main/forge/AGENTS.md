# forge — AGENTS.md

Which hosting product a repo's `origin` points at, and how to ask it for
change-request status. `PrService` (in `../github/`) is the only consumer; it
speaks `PrSummary` and never learns which forge answered.

- **The seam is `ForgeProvider`** (`types.ts`): four methods — token, branches,
  commits, numbers. That is exactly what `PrService` used to inject as four
  loose functions, which is why the service body did not change. Add a forge by
  implementing those four, not by touching the service — and see **Adding a
  forge** below for the other six entries a product owes.
- **`ForgeRepo.path` is one string, deliberately.** A GitLab project can live at
  any depth (`pwrdrvr/qa/forge/PwrGit-Test`), so `{owner, repo}` cannot hold it.
  GitHub paths are always exactly one slash and `githubOwnerAndName()` splits
  them back for GraphQL. A flat test repo will hide a regression here — use a
  nested one.
- **Return an entry for every key requested.** An explicit `null` is what makes
  a branch or commit negative-cache; omitting the key makes the service refetch
  it forever. `withNullsForMissing()` does this. Keys are omitted only where a
  lookup *failed*, never where it answered: a single unreachable commit, and a
  batch the walk never reached (see "A batch that fails keeps the batches
  before it"). Both exist so a blip is not cached as "no change request", and
  `PrService` remembers the attempt instead — the two bullets near the end of
  this list are the other half of this rule.
- **Forge hosts are enumerated, not guessed** (`cli-hosts.ts`, `hosts.ts`).
  `gh auth status --json hosts` and `glab auth status --all` report what each
  CLI is signed in to, and enumeration carries the product with it — `gh` only
  knows GitHub hosts, `glab` only GitLab ones. The user may also add a host by
  hand, naming the instance and its product together. **A git remote is never a
  source**: it is an ssh target, so a NAS or a box on a home network would
  otherwise earn a settings row and a "which forge is this?" question.
  `ForgeHosts.kindFor` returns null for anything unknown, and null is silent —
  no row, no prompt, no feature — exactly the best-effort no-op this module has
  always had for an unrecognized remote.
  - `glab auth status` writes its report to **stderr**. Reading it through
    `runGlab`'s resolved stdout returns an empty string and enumerates nothing,
    silently, on a machine that is signed in — use the runner's `onStderr` hook,
    and keep a non-zero exit's output (glab exits non-zero when ANY configured
    instance fails, and the hosts it did reach are still in there).
  - `gh` supports several accounts per host; take the **active** one, since that
    is the credential `gh api --hostname` would use.
  - **A hostname is never evidence, in any layer.** Shared's
    `classifyForgeHost` (which `resolve.ts` delegates to) used to read a
    `gitlab.*` prefix as GitLab, so a host no CLI was signed in to resolved for
    change-request status while `ForgeHosts` reported it unknown. That rule is
    gone from both places that had it: shared, and `packages/mcp-server`'s
    `classifyProvider`, which bundles standalone and so keeps its own copy of
    the *rule* while importing none of the code. (`resolve.ts` never had it —
    it delegates.) Shared's takes the host map; the MCP server has no settings
    file and no CLI enumeration, so it takes the same
    `PWRGIT_{GITHUB,GITLAB}_HOSTS` variables the app reads. Nothing anywhere
    reads a host's NAME.
  - **The list travels as a map, and `forge:hosts` ships main's own.** The
    channel returns `overrides` beside the settings `hosts` rows, because the
    two are not the same set: rows are "what has a settings row", and a host
    named only by `PWRGIT_{GITHUB,GITLAB}_HOSTS` has none. A renderer that
    rebuilt the map from rows disagreed with every main-side caller about
    exactly those hosts. Every caller that has a map must pass it —
    `parseForgeRemote` with no map is `other` for every self-managed instance,
    which is how identity marks or a clone dialog quietly lose a signed-in
    Enterprise host. The only caller that may omit it is one already pinned to
    a single hostname (`parseGitHubRemote`).
  - **A forge kind is not a host. Pass the hostname too.**
    `ForgeRepoRegistry.get(kind)` with no hostname returns the **SaaS**
    provider, so a request that carries only `host: "github"` for a project on
    `ghe.acme.example` is answered by github.com — and a slug that exists on
    both confirms, displays, clones, or forks the wrong repository, silently.
    `repo:checkCloneSource`, `repo:forkPreflight`, `repo:forkTargets` and
    `repo:clone`/`repo:fork` all carry `hostname` for this reason, and every
    provider lookup on those paths passes it. **`repo:searchCloneSources` is
    the one that does not** — search still runs against the SaaS instance, so a
    user signed in only to a company host can paste a URL and clone it but gets
    nothing from typing a partial name. Widening it means adding `hostname` to
    that channel and to `knownOwners`, whose `ForgeOwner` has no hostname
    field. The mistake is invisible until someone has an Enterprise host, which
    is why it survived: before hosts were enumerated, those hosts resolved to
    `other` and never reached a provider.
    `ForgeRepoRegistry.get` canonicalizes the hostname it is handed and refuses
    anything that is not a bare host, so a renderer string cannot reach a `gh
    --hostname` argument as an option or a URL.
  - **Resolution and permission are different questions, and both must be
    asked.** `ForgeHosts.overrides()` deliberately keeps hosts the user
    switched OFF, so classifying with it is not consent to talk to them. Every
    consumer re-checks it — `resolveEnabledForge` in `index.ts`,
    `IdentityService`'s injected `isHostEnabled`, and `forgeBlockAt(status,
    hostname)` in `clone-service.ts`/`fork-service.ts` (including the two that
    act: `CloneService.runClone`'s CLI branch and `ForkService.fork`, which
    creates a repository). A consumer that skips it spawns a CLI for a host the
    settings pane paints as off, and the dialogs cannot be relied on to have
    asked — `forge_host_off` is in `FORGE_UNASKED_CODES`, so the clone dialog
    deliberately swallows it.
    The probe target set is derived from `overrides()`, not `list()`, so a host
    that resolves is always a host the probe covered — `forgeLoggedInAt` falls
    back to the forge-wide summary for anything it did not, and that fallback
    answered "signed out" for env-allowlisted hosts.
  - **Canonicalize with `canonicalForgeHostname` (shared), everywhere.** The
    settings write path and host resolution must agree byte-for-byte, or a
    setting persists under a key no lookup matches and silently does nothing.
- **`cli-runner.ts` is the audited `gh`/`glab` process spawner** — no inherited
  TTY, no prompt, bounded output, and credentials never reaching a diagnostic.
  It is `gh-cli.ts`'s former body with the brand-specific parts lifted into a
  `CliSpec`. Change behavior here, not in a copy; `../github/gh-cli.test.ts`
  covers it and must keep passing.
- **`retry.ts` holds the one retry/backoff decision** every forge client makes.
  A forge contributes a row in the dialect table there — how its rate-limit
  headers are spelled, and every status that carries a window (GitHub reports a
  spent hourly budget as 403 as well as 429; GitLab only ever 429) — plus a
  short adapter reading status and headers off its own error type. Both clients
  carried a copy of the decision before, so a fix to one silently missed the
  other; the ordering, and what it deliberately does not do, are in the file's
  own header. Retry *budgets* stay with the caller: how many attempts a call may
  spend is not policy, which is what lets commit association below choose fewer
  than the branch query.
- **A refusal is not an answer.** Both clients negative-cache "no change
  request" from what a query returns, so a response that resolved nothing must
  fail rather than return — a null `repository`/`project` container, or a 200
  that was never the JSON we asked for, would otherwise write "no PR" onto every
  branch in the batch and hold it for the refresh TTL. `PrService` treats a
  thrown refresh as best-effort and keeps what it had. This is the other half of
  "return an entry for every key requested" above: the rule applies to keys the
  forge actually answered about.
- **A batch that fails keeps the batches before it** — `chunked.ts`, one
  helper, for the same reason `retry.ts` is one helper. Every client walks its
  keys in chunks (~50), so 250 branches refused on the fourth request must
  still return the 150 that resolved; only a *first* chunk failing rethrows,
  because that is the "nothing resolved" the rule above is about. Two details
  the helper's shape enforces rather than leaves to each caller:
  - **Only the fetch is inside the `try`.** Parsing sits outside, because a
    parser throwing is a bug in us, not a refusal by the forge — swallowing it
    would turn a `TypeError` into a silent short map whose visibility depends
    on how many branches the repo happens to have.
  - **The walk stops at the failing chunk** rather than skipping to the next: a
    revoked token or a complexity cap refuses every chunk alike, so continuing
    would spend the whole retry budget again per chunk.
  GitLab's branch query is the one batch that cannot separate fetch from parse
  (paging decisions need parsed data), so it is a named function,
  `newestMrPerBranch`, and an abandoned batch contributes nothing at all —
  filling its nulls would negative-cache branches whose MR is on a page never
  read.
- **Never negative-cache a failure, but do remember that you tried.** A refusal
  writes no row, so the `fetched_at` every TTL reads is unchanged and nothing
  throttles the retry — without a separate mark, a permanently refused query
  (a GHES validation error, a complexity cap, a revoked token) is re-sent on
  every repo-row expand, hover and worktree-monitor replacement, and the
  callers queued behind an in-flight refresh each start an attempt of their own
  when it settles. `PrService.lastFailedAt` is the in-memory answer, the same
  shape as the signed-out backoff below, and it is read against the TTL a
  successful attempt would have earned. Four things about it are load-bearing:
  - **It is keyed by scope, not just by repository** (`FailureScope`: a
    whole-repo sweep, a targeted refresh, commits). A forge that refuses one
    query shape routinely answers another, so a repo-wide mark is wrong in
    *both* directions: a hover's success would delete the sweep's backoff, and
    a hover's repeated failure would re-stamp it faster than the sweep's ten
    minutes could elapse — starving the only refresh that covers every branch.
  - **A mark from the future is ignored.** `Date.now()` is not monotonic, and
    without the upper bound a backward clock step suppresses every refresh
    until the clock catches up. Nothing in the renderer sends `force`, so
    there would be no escape short of a restart.
  - **Writes are generation-guarded**, or a refresh already in flight re-arms
    what `invalidatePendingWrites` just cleared. `forget(repoId)` drops one
    repository's marks; repo ids are path-derived and reused.
  - **A partial branch answer counts as a failed attempt too.** `isFresh` is
    all-or-nothing, so one omitted branch leaves the whole repo stale and the
    next trigger re-sends every chunk. The chunks that did resolve are still
    written — that is the forward progress. Commits are the opposite: freshness
    is per hash, so a partial batch shrinks the next `stale` set by itself and
    only a total failure is marked. Which is why `fetchMrsForCommits` **throws**
    when every SHA failed: reporting that as an empty map would read as a clean
    answer, clear the backoff, and let the 60s poll re-fan-out sixty REST calls
    forever.
  `refreshPrNumbers` deliberately has no mark: its only caller is
  `PrStatusMonitor`'s fixed 60s timer, which no UI interaction can accelerate,
  so a mark would save at most one request per minute per repo.

## Adding a forge

**A provider class per seam, plus one registry entry.** Nothing else should be
needed, and `tsc` is what proves it. Add the member to `FORGE_KINDS`
(`packages/shared/src/types.ts`) and run `pnpm typecheck`: every site that needs
filling in is a missing-property error naming its own file. There are seven.

- `FORGE_PRODUCTS` — `packages/shared/src/forge-product.ts`. **Data only**, and
  it is the one the renderer reads too: name, CLI, SaaS host, the
  change-request noun and sigil, the word for a non-personal account, project
  path depth, the env host allowlist, the "add a host" wording, whether forking
  is asynchronous, and what the integration can answer (`capabilities`).
- `PROVIDERS` (`providers.ts`) — change-request status, the `ForgeProvider`
  seam `PrService` depends on.
- `REPO_PROVIDERS` (`repo-providers.ts`) — the `ForgeRepoProvider` seam clone
  and fork reach through `ForgeRepoRegistry`.
- The commit-author transports (`commit-author-transport.ts`).
- `HOST_ENUMERATORS` (`cli-hosts.ts`) — how that CLI reports its signed-in
  hosts.
- `DEFAULT_PROBES` (`status.ts`) — installed, and signed in at a host.
- `RATE_LIMIT_DIALECT` (`retry.ts`) — how its rate-limit headers are spelled.

Verify with the acceptance test the refactor was written against: add a
throwaway third kind, confirm `tsc` names exactly those seven, remove it.

**`packages/mcp-server` is the one place `tsc` cannot help.** It bundles
standalone and imports nothing from `@pwrgit/shared`, so it keeps its own
`"github" | "gitlab"` union, its own `classifyProvider`, and its own literal
`PWRGIT_{GITHUB,GITLAB}_HOSTS` names — the same *rules* as the app, none of the
same code. A third product has to be added there by hand, or the MCP server
silently reports its checkouts as `other`.

### Why they are all records

The two shapes fail differently, and that difference is the whole rule:

- **`Record<ForgeKind, …>` fails loudly.** A new kind is a missing-property type
  error, so `tsc` hands you the list to fill in.
- **A ternary fails silently.** `kind === "gitlab" ? glab : gh` sends a third
  forge at GitHub, and nothing catches it — not the compiler, and not a test
  that only covers the two kinds that exist today. **A hand-written pair of
  calls is the same failure**: two literal `forges.register(...)` calls left a
  third product's clone and fork reported as `unsupported_host` on a machine
  whose CLI was installed and signed in.

This count is a regression test, and it must read zero:

```bash
grep -rn '=== "github"\|=== "gitlab"' --include=*.ts --include=*.tsx \
  packages/shared/src apps/desktop/src | grep -v '\.test\.'
```

It was 29 across 18 files before the registry landed.

So, when adding anything per-product:

- **Never write a new `=== "github"` / `=== "gitlab"` comparison.** If you are
  reaching for one, the value belongs in `FORGE_PRODUCTS` (data) or behind a
  provider method (behaviour). `isForgeKind` and `toForgeHost` (shared) are the
  guards; `forgeProductFor` / `forgeProductOrAssumed` are the accessors.
- **`FORGE_KINDS` is the member list.** `Object.keys(table) as ForgeKind[]`
  asserts a table is complete instead of proving it, which is exactly the
  assertion that goes stale.
- **Put data in `packages/shared`**, even where only main reads it today.
  `renderer-does-not-import-main` blocks main's tables, and a renderer-local
  copy is how `FORGE_CLI` ended up with two spellings — as did `KIND_LABEL` and
  `FORGE_LABELS`, the same map in the same directory because each new screen
  added its own.
- **`ASSUMED_FORGE_KIND` is the one place `other` becomes GitHub.** Eight
  ternaries used to answer an unclaimed host as GitHub — a clone hint, a default
  hostname, an error sentence. That is preserved, not endorsed; it is named so
  it is greppable when somebody takes the question on.

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
- **`forge:status` is a summary of the per-host state, not a second opinion on
  it.** Settings renders two sections — Hosts (`ForgeHostsSection.tsx`, from
  `forge:hosts`) and the per-forge card below it (`ForgesSettings.tsx`, from
  `forge:status`) — and they must never contradict each other. They did: the
  probe was hardcoded to `github.com` and `gitlab.com`, so the card read "GitLab:
  Signed out" directly under a Hosts row naming a self-managed instance and its
  account, and read "Connected" for a forge whose only host had been switched
  off. `ForgeStatus` now carries `hosts[]` — `{host, enabled, loggedIn}` per
  instance — and `loggedIn` is *derived* from it: true when any **enabled** host
  holds a credential. `index.ts` supplies that list from
  **`ForgeHosts.statusTargets()`**, not `list()`: `list()` answers "what has a row
  in the Hosts pane", and driving the probe from it means any single config entry
  makes the list non-empty, so a machine whose only entry is a self-managed
  instance never asks about github.com at all — and neither does anything in the
  window before enumeration lands. `statusTargets()` adds each forge's SaaS host
  when nothing names it, still gated by `isEnabled`. Do not re-derive the summary
  in the renderer, and do not wire a probe from `list()`.
  - **An `assumed` target is probed but not reported.** The backfilled SaaS host
    has no row in the Hosts pane, so `ForgeStatus.hosts` omits it — naming a host
    the user can neither see nor switch is the two-sections-disagree bug from the
    other direction, and it would also keep the pane's "Off" state unreachable by
    never letting `every` clear. It is probed **without naming a host**, because
    `GH_HOST`/`GITLAB_HOST` move the CLI's default and `--hostname github.com`
    overrides them (`../github/pr-client.ts` spells this out). Its credential
    still counts toward the summary.
  - **The two sections divide the work.** Hosts owns per-host permission and
    sign-in, one row each. The card owns what only a *product* can answer: the
    CLI is missing (there are no host rows at all then), and what the
    integration can do (`FORGE_PRODUCTS[kind].capabilities`). Folding those
    into host rows would repeat the same sentence once per host of that forge
    and leave the missing-CLI case nowhere to be reported.
  - **Four states, and "off" is not one of the other three.** A forge whose every
    host is switched off is neither connected nor signed out — reporting it as
    either sends the user to a terminal to sign in to something they are already
    signed in to. It renders neutral, not amber: they chose it.
- **A disabled host is never probed.** Gating on `enabled` is what makes "off"
  mean off — the switch exists to stop PwrGit spawning that CLI, and a probe that
  ran anyway would spawn it to populate a settings pane. `loggedIn` on a disabled
  host is therefore *not asked*, not *false*; `enabled` is what says why, and
  collapsing the two is what made "off" read as "signed out".
- **Both inputs to the host list re-probe; neither is allowed to be forgotten.**
  The switches AND the enumerated directory feed `statusTargets()`, and both are
  inputs to a five-minute cache. `index.ts` compares the *resolved target
  signature* and forces a read when it moves — which covers a settings write, the
  arrival of boot enumeration, and the Hosts pane's own **Re-check** button, while
  costing nothing for a theme toggle. Keying it on the stored settings alone left
  the card reading "Signed out" beneath a row saying "signed in as …" until the
  TTL expired, with no user-reachable way to force it. It is debounced: each host
  switch is its own settings write, so a burst otherwise chained one full pass per
  click.
- **A forced read is the whole invalidation story.** `list({force:true})` retires
  the cache *and* bumps an epoch, so a pass already in flight still resolves for
  whoever awaited it but may not cache or broadcast. Without the epoch, nulling
  the cache made that stale pass compare as "changed" and publish its pre-action
  answer, painting the state the user had just changed away from. There is
  deliberately no separate `invalidate()` to forget to call.
- **`forge:status` has three consumers, and two of them ask a narrower
  question.** Settings → Forges wants "can this forge be read at all", which is
  the summary. The clone and fork dialogs reach their provider through
  `ForgeRepoRegistry.get(kind)` with no hostname — the **SaaS** instance — so
  they ask **`forgeSaasBlock`** (shared) — `forgeCanAnswerDialog` in
  `fork-dialog.ts` and `ForkService`/`CloneService`'s own gates are all that one
  function. Reading the summary there would let a self-managed sign-in enable a
  gitlab.com search that cannot answer, failing late instead of naming what is
  missing; `clone-service.ts`'s `forgeUnavailable` did exactly that while
  `knownOwners` sixty lines above it did not.
  - **Three reasons, not two.** `forgeSaasBlock` returns `cli_missing`,
    `host_off` or `signed_out`. "Switched off" is not "signed out": telling
    someone to run `glab auth login` for a host they turned off names a remedy
    that cannot work, which is the collapse `ForgeHostStatus.loggedIn` is
    documented to avoid. `forge_host_off` joins the codes the clone dialog treats
    as "the forge was not asked".
  - A host the probe did not cover falls back to the summary deliberately — an
    `assumed` host is reported nowhere, and absence is not evidence. Matching is
    canonicalized on both sides (`canonicalForgeHostname`), or the miss is silent
    and lands on the permissive answer.
- **`forge:status` is answered from a cached probe** (`status.ts`). Probing
  spawns a subprocess *per enabled host*, so the cache is the point — repeat
  reads collapse onto one value and one in-flight promise. A broken forge
  re-probes sooner than a healthy one, and listeners are woken only when
  something rendered actually changed — which now includes the per-host detail,
  since turning one of two signed-in hosts off leaves the summary alone.
- **Capabilities describe the integration, not a login**
  (`FORGE_PRODUCTS[kind].capabilities`, shared), so they are static per forge
  and need no network call. `batchedCommitAssociation` is false for GitLab
  because it has no batch endpoint; callers use that to avoid asking rather
  than to handle a failure.

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

## Repository metadata: a second seam, deliberately separate

`ForgeProvider` above answers change-request status. Clone, fork and the repo
identity marks need different verbs — visibility, fork lineage, listing,
creating a fork — so they hang off `ForgeRepoProvider` (`repo-provider.ts`)
rather than widening the four-method seam `PrService` depends on. Same two
forges, same CLI clients, disjoint questions.

Electron E2E replaces this seam only when `PWRGIT_E2E_FORGE_FIXTURE` names a
fixture file. Keep that wiring in `e2e-forge-fixture.ts`: tests must exercise
the real renderer/IPC/services/indexer and must never stub commands above the
provider or reach a real forge.

- **What a forge cannot do belongs in its `capabilities`**
  (`FORGE_PRODUCTS`, shared), the one table both Settings → Forges and the
  dialogs read. GitLab's fork API has no default-branch-only equivalent, so
  `forkDefaultBranchOnly` is false there and the fork dialog hides the switch —
  a control that is accepted and silently ignored is worse than one that is
  absent. Add a capability there, not as a property on a provider, or the
  settings screen will not know about it.
- **Availability is `status.ts`'s job, not a provider's.** `ForgeRepoProvider`
  answers `owners()` and nothing about installed/logged-in: probing is a
  subprocess, `ForgeStatusService` already caches one answer for the whole
  app, and a provider that probed again would spawn a second to learn what
  main already knew.
- **Identity is read from `origin`, specifically.** A fork checkout has `origin`
  (your fork) and `upstream` (the original); the marks describe what you push
  to. Results persist in `repo_identity` and are joined onto `repo:list` by
  `RepoIndexer`, so the sidebar paints marks on the first frame instead of
  arriving blank and filling in. Refreshes answer a `repo:identityChanged`
  delta the renderer patches in place — a full reload would collapse every
  expanded repo.
- **Three states, not two.** No `repo_identity` row means *never looked up*;
  `visibility: "unknown"` means *asked, and the forge would not say*. They
  render differently, and neither collapses into `public` — that would
  understate where code can go. A signed-out CLI writes **no** row (signing in
  should produce a fresh read); a 404 writes `unknown` (re-asking every pass is
  noise). Successful fetches/pulls request a background refresh under the same
  TTL as profile loads: six hours for known visibility, five minutes for
  unknown. Service-wide slots bound all overlapping calls (eight Git reads,
  four forge requests); lookups for the same repo are coalesced. Signed-out
  attempts back off five minutes in memory without writing a row. Clicking
  the sidebar visibility mark forces a refresh of just that repository and
  waits for an existing lookup when one is already running. IPC returns the
  lookup outcome separately from deltas: signed-out attempts may retain a
  known identity, and a change to unknown is still unresolved. Only a resolved
  outcome warrants successful visibility feedback.
- **A dialog opens on local state; a forge is asked only on debounced input.**
  This is the rule the clone dialog broke. `repo:cloneCatalog` used to list
  every known owner's repositories as it opened — `gh repo list <owner>
  --limit 200`, three owners at a time — so a profile with sixteen owners sat
  on "Loading repositories…" for **13 seconds** before the user had typed a
  character, and typing then only filtered what had already arrived. It now
  answers from `repo_identity` and the cached status probe (~0ms of forge
  work), and `repo:searchCloneSources` asks `gh search repos` / GitLab's
  project search once, 300ms after the box settles. Concretely:
  - **No `list everything` verb on `ForgeRepoProvider`.** `searchRepos` takes a
    term and owners together; there is deliberately no way to ask for one
    account's whole inventory, because that is the call that gets made N times
    in a loop.
  - **Owner-scoped in one call, never one call per owner.** `gh search repos`
    repeats `--owner=`; GitLab has no equivalent, so several owners become one
    instance-wide search narrowed afterwards, and an empty term with several
    owners is declined rather than enumerated.
  - **`owner/term` scopes the search.** A half-typed slug like `pwrdrvr/micro`
    would only 404 the exact check, so it also runs as an owner-scoped search.
- **Answer "which local checkouts are this repository?" from SQLite.**
  `repo_identity` is joined onto `repo:list` already. Both the clone catalog
  and the fork preflight used to answer it by spawning `git remote -v` /
  `git remote get-url origin` in **every indexed repository** — 52 subprocesses
  per call on a mid-size profile, on the exact-name check as well as on open.
  `localForgeState` (clone-service) and `checkoutsFor` (fork-service) are both
  pure reads over `Repo.identity` now. Fork parents in that table are what
  keeps the owner list as wide as the old `upstream`-remote scan made it.
- **Loading is not unavailable.** The fork dialog once reported an in-flight
  catalog as "install the GitHub CLI" on a machine with `gh` installed and
  signed in — the state it spends its first seconds in. `sourceEmptyMessage`
  owns that wording so a test pins it.
- **GitLab calls them groups, not organizations.** `ownerKindLabel` reads the
  product's `organizationNoun`; the fork-target list is the one place the user
  chooses between them, so a wrong noun there is wrong where it shows most.
