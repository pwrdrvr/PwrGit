# forge — AGENTS.md

This module decides which hosting product (forge) a repo's `origin` points at,
and asks that forge for change-request status. The consumers are `PrService`
and `OpenPrService` (`../github/`). They speak `PrSummary` and never learn
which forge answered. Per-forge detail: `gitlab/AGENTS.md`, `gitcafe/AGENTS.md`.

**Always apply:**

- **Return an entry for every key requested.** `null` is a negative cache; an
  omitted key is a failure.
- **A refusal is not an answer.** Throw when a response resolved nothing.
- **Never negative-cache a failure.** Record the attempt instead.
- **A hostname is never evidence** of which product runs at a host.
- **A forge kind is not a host.** Pass the hostname too.
- **Never write `=== "github"` / `=== "gitlab"`.** Use a `Record<ForgeKind, …>`.
- **Only main talks to a forge.**

### The provider seam

- **The seam is `ForgeProvider`** (`types.ts`), in two shapes:
  - `TokenForgeProvider` (GitHub, GitLab): token, branches, commits, numbers,
    and the open list. `connectForge` binds the token to the other four.
  - `CliForgeProvider` (GitCafe): a `ForgeConnection` with the four reads. It
    authenticates inside each command.
- Token, branches, commits and numbers are the four functions `PrService` used
  to inject, so its body did not change. The open list belongs to
  `OpenPrService`.
- Add a forge by implementing these methods. Do not change either service.
- **The open list (`fetchOpenPrs`) is the one read not keyed by a local ref.**
  So only it finds a change request whose head the checkout never saw: every
  fork's, and any opened since the last fetch. It owes two rules:
  - **A complete walk, or a throw.** `OpenPrService` replaces the stored list
    by diff, so a short answer *deletes* the change requests it left out. Walk
    every page up to `OPEN_PR_LIST_CAP` and set `truncated` past it. Throw on a
    failed page, a repeated cursor, or a null project.
  - **Mark a fork with `headRepoPath`**, in the list AND in
    `fetchPrsByNumbers`. Heads match local branches by name, and a fork's
    `main` is not ours. Without the mark, a merged fork PR offered
    "Show worktree" on the user's own `main`.
  - A fork the forge will not name is `UNAVAILABLE_FORK`. Its head stays
    reachable by `FORGE_PRODUCTS[kind].changeRequestHeadRef`, checked out as
    `changeRequestLocalBranch` (`pr/121`).
- **`ForgeRepo.path` is one string, on purpose.** A GitLab project can live at
  any depth (`pwrdrvr/qa/forge/PwrGit-Test`), so `{owner, repo}` cannot hold
  it. GitHub paths have exactly one slash; `githubOwnerAndName()` splits them
  for GraphQL. Test with a nested repo: a flat one hides a regression.
- **Return an entry for every key requested.** `null` negative-caches a branch
  or commit. An omitted key is refetched forever. `withNullsForMissing()`
  fills the nulls.
  - Omit a key only where the lookup *failed*: a single unreachable commit, or
    a batch the walk never reached. This stops a blip being cached as
    "no change request". `PrService` records the attempt instead (see
    [Failures](#failures)).

### Forge hosts

- **Forge hosts are enumerated, not guessed** (`cli-hosts.ts`, `hosts.ts`).
  `gh auth status --json hosts` and `glab auth status --all` report each CLI's
  signed-in hosts. Enumeration carries the product: `gh` knows only GitHub
  hosts, `glab` only GitLab hosts. The user can also add a host by hand, with
  its product.
- **A git remote is never a source.** A remote is an ssh target, so a NAS
  would get a settings row and a "which forge is this?" question.
- `ForgeHosts.kindFor` returns null for an unknown host. Null is silent: no
  row, no prompt, no feature.
- `glab auth status` writes its report to **stderr**. `runGlab`'s resolved
  stdout is empty, so enumeration finds nothing on a signed-in machine. Use
  the runner's `onStderr` hook. Keep the output of a non-zero exit: glab exits
  non-zero when ANY configured instance fails, and still lists the hosts it
  reached.
- `gh` allows several accounts per host. Take the **active** one: `gh api
  --hostname` uses it.
- **A hostname is never evidence, in any layer.** Nothing reads a host's NAME
  to decide its product.
  - Shared's `classifyForgeHost` (`resolve.ts` delegates to it) once read a
    `gitlab.*` prefix as GitLab. A host no CLI was signed in to then resolved
    for change-request status while `ForgeHosts` called it unknown.
  - The rule is gone from shared (which now takes the host map) and from
    `packages/mcp-server`'s `classifyProvider`. The MCP server has no settings
    file or CLI enumeration, so it reads the same
    `PWRGIT_{GITHUB,GITLAB}_HOSTS` variables as the app.
- **The list travels as a map, and `forge:hosts` ships main's own.** The
  channel returns `overrides` beside the settings `hosts` rows. A host named
  only by `PWRGIT_{GITHUB,GITLAB}_HOSTS` has no row. So a renderer that rebuilt
  the map from rows disagreed with main about those hosts.
- **Every caller that has a map must pass it.** `parseForgeRemote` with no map
  returns `other` for every self-managed instance, and identity marks or the
  clone dialog lose a signed-in Enterprise host. Only a caller pinned to one
  hostname may omit it (`parseGitHubRemote`).
- **A forge kind is not a host. Pass the hostname too.**
  `ForgeRepoRegistry.get(kind)` with no hostname returns the **SaaS** provider.
  A request with only `host: "github"` for a project on `ghe.acme.example` then
  confirms, displays, clones or forks the github.com repo with the same slug.
  - `repo:checkCloneSource`, `repo:forkPreflight`, `repo:forkTargets` and
    `repo:clone`/`repo:fork` carry `hostname`, and every provider lookup on
    those paths passes it.
  - **`repo:searchCloneSources` does not.** Search runs against the SaaS
    instance only. A user signed in only to a company host can paste a URL and
    clone, but a partial name finds nothing. To fix it, add `hostname` to that
    channel and to `knownOwners` (its `ForgeOwner` has no hostname field).
  - `ForgeRepoRegistry.get` canonicalizes the hostname and refuses anything
    but a bare host. So a renderer string cannot reach `gh --hostname` as an
    option or a URL.
- **Resolution and permission are different questions. Ask both.**
  `ForgeHosts.overrides()` keeps switched-OFF hosts on purpose, so classifying
  with it is not consent. Every consumer re-checks:
  - `resolveEnabledForge` in `index.ts`;
  - `IdentityService`'s injected `hosts.isEnabled`;
  - `forgeBlockAt(status, hostname)` in `clone-service.ts`/`fork-service.ts`,
    including `CloneService.runClone`'s CLI branch and `ForkService.fork`
    (which creates a repository).
  - A consumer that skips the check spawns a CLI for a host shown as off. Do
    not rely on the dialogs: `forge_host_off` is in `FORGE_UNASKED_CODES`, so
    the clone dialog swallows it.
- The probe target set comes from `overrides()`, not `list()`, so every host
  that resolves was probed. Otherwise `forgeLoggedInAt` falls back to the
  forge-wide summary, which answered "signed out" for env-allowlisted hosts.
- **Canonicalize with `canonicalForgeHostname` (shared), everywhere.** If the
  settings write path and host resolution differ by one byte, a setting
  persists under a key no lookup matches.

### Shared helpers

- **`cli-runner.ts` is the audited `gh`/`glab` process spawner:** no inherited
  TTY, no prompt, bounded output, no credentials in a diagnostic. It is the
  former `gh-cli.ts` body with brand parts moved into a `CliSpec`. Change
  behavior here, not in a copy. `../github/gh-cli.test.ts` must keep passing.
- **`retry.ts` holds the one retry/backoff decision** for every forge client,
  so a fix cannot reach one client and miss another. Its header documents the
  ordering and the non-goals.
  - A forge adds a dialect-table row (header spelling, and every status that
    carries a window) and a short adapter that reads its own error type.
    GitHub reports a spent hourly budget as 403 or 429; GitLab uses only 429.
  - Retry *budgets* stay with the caller. So commit association can use fewer
    attempts than the branch query.

### Failures

- **A refusal is not an answer.** Clients negative-cache "no change request"
  from a query result. So a null `repository`/`project` container, or a 200
  that is not our JSON, must throw. Returned, it writes "no PR" on every branch
  in the batch for the refresh TTL. `PrService` treats a thrown refresh as
  best-effort and keeps what it had.
- **A batch that fails keeps the batches before it** (`chunked.ts`, one
  helper). Clients walk keys in chunks of ~50. If the fourth request fails, the
  150 resolved branches still return. Only a failed *first* chunk rethrows.
  - **Only the fetch is inside the `try`.** A parser throw is our bug, not a
    refusal. Swallowed, a `TypeError` becomes a silent short map.
  - **The walk stops at the failing chunk.** A revoked token or complexity cap
    refuses every chunk, so continuing spends the retry budget again per chunk.
  - GitLab's branch query cannot separate fetch from parse (paging needs parsed
    data), so it is the named function `newestMrPerBranch`. An abandoned batch
    contributes nothing; filling its nulls would negative-cache branches whose
    MR is on an unread page.
- **Never negative-cache a failure, but do remember that you tried.** A refusal
  writes no row, so `fetched_at` does not move and nothing throttles the retry.
  A permanently refused query (GHES validation error, complexity cap, revoked
  token) would be re-sent on every repo-row expand, hover and worktree-monitor
  replacement. Callers queued behind an in-flight refresh would each retry.
  `PrService.lastFailedAt` is the in-memory mark, read against the TTL a
  success would have earned. Four properties are load-bearing:
  - **Keyed by scope** (`FailureScope`: whole-repo sweep, targeted refresh,
    commits). A forge that refuses one query shape often answers another. With
    one repo-wide mark, hover failures re-stamp faster than the sweep's ten
    minutes and starve the only refresh that covers every branch.
  - **A mark from the future is ignored.** `Date.now()` is not monotonic. A
    backward clock step would suppress every refresh, and nothing in the
    renderer sends `force`.
  - **Writes are generation-guarded**, so an in-flight refresh cannot re-arm
    what `invalidatePendingWrites` cleared. `forget(repoId)` drops one repo's
    marks, because repo ids are path-derived and reused.
  - **A partial branch answer is a failed attempt.** `isFresh` is
    all-or-nothing, so one omitted branch re-sends every chunk. Resolved chunks
    are still written. Commit freshness is per hash, so only a total failure is
    marked. So `fetchMrsForCommits` **throws** when every SHA failed: an empty
    map would clear the backoff, and the 60s poll would send sixty REST calls
    forever.
  - `refreshPrNumbers` has no mark. Its only caller is `PrStatusMonitor`'s
    fixed 60s timer, so a mark saves at most one request per minute per repo.

## Adding a forge

**A provider class per seam, plus one registry entry.** Add the member to
`FORGE_KINDS` (`packages/shared/src/types.ts`) and run `pnpm typecheck`. Each
site to fill in is a missing-property error that names its file. There are
seven:

- `FORGE_PRODUCTS` (`packages/shared/src/forge-product.ts`). **Data only**;
  the renderer reads it too. Name, CLI, SaaS host, change-request noun and
  sigil, non-personal account word, project path depth, env host allowlist,
  "add a host" wording, async forking, and `capabilities`.
- `PROVIDERS` (`providers.ts`): the `ForgeProvider` seam.
- `REPO_PROVIDERS` (`repo-providers.ts`): the `ForgeRepoProvider` seam that
  clone and fork reach through `ForgeRepoRegistry`.
- The commit-author transports (`commit-author-transport.ts`).
- `HOST_ENUMERATORS` (`cli-hosts.ts`): how the CLI reports signed-in hosts.
- `DEFAULT_PROBES` (`status.ts`): installed, and signed in at a host.
- `RATE_LIMIT_DIALECT` (`retry.ts`): rate-limit header spelling.

To verify, add a throwaway kind, confirm `tsc` names exactly those seven, and
remove it.

`REPO_PROVIDERS`, `DEFAULT_PROBES` and `FORGE_PRODUCTS` (no `kind` field) bind
the key to the value's kind. `ForgeRepoRegistry` keys off `provider.host`, not
the table key. So a value that disagrees with its key sends one product's hosts
to another product's CLI.

**`packages/mcp-server` is the one place neither `tsc` nor the lint helps.** It
bundles standalone and imports nothing from `@pwrgit/shared`. It keeps its own
`"github" | "gitlab" | "gitcafe"` union, `classifyProvider`, and literal
`PWRGIT_{GITHUB,GITLAB}_HOSTS` names. The order differs: it tests SaaS
hostnames before the env allowlist; `ForgeHosts.kindFor` tests env first. Add a
new product there by hand, or its checkouts report as `other`.

### Why they are all records

- **`Record<ForgeKind, …>` fails loudly.** A new kind is a missing-property
  error, so `tsc` lists what to fill in.
- **A ternary fails silently.** `kind === "gitlab" ? glab : gh` sends a new
  forge to GitHub, and no compiler or two-kind test catches it.
- **A hand-written pair of calls fails the same way.** Two literal
  `forges.register(...)` calls reported a third product's clone and fork as
  `unsupported_host` while its CLI was signed in.

**`pnpm lint:forge-kinds` is the regression test.** It runs second in
`pnpm lint` (after `lint:syntax`), so CI's Typecheck job runs it. It fails on
any hand-written kind comparison (`x === "github"`, `x !== "gitlab"`,
`case "gitlab":`) in non-test source under `packages/shared/src` or
`apps/desktop/src`. It reads the kinds from `FORGE_KINDS`. There were 29
violations in 18 files before the registry. Never fix a violation with an
exception in the script.

When you add anything per-product:

- **Never write a new `=== "github"` / `=== "gitlab"` comparison.** Put the
  value in `FORGE_PRODUCTS` (data) or behind a provider method (behaviour).
  Guards: `isForgeKind`, `toForgeHost` (shared). Accessors: `forgeProductFor`,
  `forgeProductOrAssumed`.
- **`FORGE_KINDS` is the member list.** `Object.keys(table) as ForgeKind[]`
  asserts completeness instead of proving it.
- **Put data in `packages/shared`**, even if only main reads it today.
  `renderer-does-not-import-main` blocks main's tables, and renderer-local
  copies drift: `FORGE_CLI` got two spellings, and `KIND_LABEL` and
  `FORGE_LABELS` were the same map in one directory.
- **`ASSUMED_FORGE_KIND` is the one place `other` becomes GitHub** (formerly
  eight ternaries: a clone hint, a default hostname, an error sentence). The
  behavior is kept, not endorsed; the name makes it greppable.

## GitLab specifics

Fork, path and group rules are in [gitlab/AGENTS.md](gitlab/AGENTS.md). For
change-request status:

- **Batching is native.** `mergeRequests(sourceBranches: [...])` takes a list,
  so one field replaces GitHub's ~50 aliases. The response is flat; we group
  per branch and fill nulls.
- **`iid` is a GraphQL String**, but REST sends a number. Everything goes
  through `toSummary`'s `toNumber`.
- **States are lowercase, with a fourth value.** `locked` (discussion locked)
  maps to `open`; as terminal, it would stop refreshes. `draft` is a boolean;
  never parse a `WIP:` title.
- **Commit association has no batch API:** one REST call per SHA, bounded
  concurrency, capped per refresh. Its retry budget is smaller than the branch
  query's; otherwise an outage over 60 commits backs off for minutes on the
  hover path. The `commit_pr` cache keeps it cheap.
- **No schema migration was needed.** `branch_pr`/`commit_pr` store only the
  forge-agnostic `number/url/title/state/is_draft`.

## Status, capabilities, and who may call a forge

- **Only main talks to a forge.** The renderer asks over the bus (`pr:refresh`,
  `forge:status`) and renders what main pushes (`pr:changed`,
  `forge:statusChanged`). `renderer-does-not-call-forge-apis`
  (`.dependency-cruiser.cjs`) blocks SDK imports; review for raw `fetch`.
  Reason: React StrictMode runs effects twice in dev, so a `useEffect` makes two
  calls per mount per chip, and a commit-list sweep gets rate limited.
- **`forge:status` is a summary of the per-host state, not a second opinion.**
  The two reads must never contradict. Settings → Forges renders **one section
  per product** (`ForgeProductSection.tsx`). `ForgesSettings.tsx` holds both
  reads (`forge:hosts` rows, `forge:status` probe) and maps `FORGE_KINDS` over
  them.
  - The old probe was hardcoded to `github.com`/`gitlab.com`. It showed
    "GitLab: Signed out" under a signed-in self-managed row, and "Connected"
    for a forge whose only host was off.
  - `ForgeStatus.hosts[]` is `{host, enabled, loggedIn}` per instance. The
    summary `loggedIn` is true when any **enabled** host holds a credential.
  - `index.ts` takes targets from **`ForgeHosts.statusTargets()`**, never
    `list()`. `list()` is "has a Hosts row": one self-managed entry makes it
    non-empty, and then github.com is never probed, nor anything before
    enumeration lands. `statusTargets()` adds each forge's SaaS host when
    nothing names it, gated by `isEnabled`.
  - Do not re-derive the summary in the renderer.
- **An `assumed` target is probed but not reported.** The backfilled SaaS host
  has no Hosts row, so `ForgeStatus.hosts` omits it. Reporting it would show a
  host the user cannot switch, and `every` could never clear to "Off". It is
  probed **without naming a host**, because `--hostname github.com` overrides
  `GH_HOST`/`GITLAB_HOST` (see `../github/pr-client.ts`). Its credential counts
  toward the summary.
- **Product-level answers go in the product section, not a host row.** Rows own
  per-host permission and sign-in. The section owns CLI-installed (then there
  are no rows) and `FORGE_PRODUCTS[kind].capabilities`, once at its foot. In
  rows, capabilities would repeat per host, and a missing CLI would have nowhere
  to show.
- **Sections come from `FORGE_KINDS`, never from the rows.** Rows drop a
  product the user has not signed in to, which is the product whose sign-in
  needs a section. A shared empty state fails too: "No forge CLI (`gh`,
  `glab`) is signed in" never says *which* one to fix.
- **Four states; "off" is not one of the other three.** A forge with every host
  off is neither connected nor signed out; either label sends the user to sign
  in again. It renders neutral, not amber, because the user chose it.
- **A disabled host is never probed.** The switch exists to stop PwrGit
  spawning that CLI. `loggedIn` on a disabled host means *not asked*, not
  *false*; `enabled` says why. Collapsing the two made "off" read as
  "signed out".
- **Both inputs re-probe.** The switches and the enumerated directory feed
  `statusTargets()`, behind a five-minute cache. `index.ts` forces a read when
  the *resolved target signature* moves: a settings write, boot enumeration,
  or the Hosts pane's **Re-check**. A theme toggle costs nothing. Keyed on
  stored settings alone, the card read "Signed out" under "signed in as …"
  until the TTL expired. It is debounced, because each host switch is its own
  settings write.
- **A forced read is the only invalidation.** `list({force:true})` retires the
  cache *and* bumps an epoch. An in-flight pass still resolves for its awaiters
  but cannot cache or broadcast. Without the epoch, it published the
  pre-change answer. There is no separate `invalidate()`, on purpose.
- **`forge:status` is answered from a cached probe** (`status.ts`), because
  probing spawns a subprocess *per enabled host*. Repeat reads share one value
  and one in-flight promise. A broken forge re-probes sooner. Listeners wake
  only when something rendered changed, including per-host detail.
- **Clone and fork ask a narrower question:
  `forgeBlockAt(status, hostname)`** (shared). Settings uses the summary.
  `forgeCanAnswerDialog` (`fork-dialog.ts`) and the `ForkService`/
  `CloneService` gates call it; `forgeSaasBlock` is it with the SaaS hostname.
  The summary there would let a self-managed sign-in enable a gitlab.com search
  that fails late (as `clone-service.ts`'s `forgeUnavailable` did).
  - It returns `cli_missing`, `host_off` or `signed_out`. `glab auth login`
    cannot fix a host the user switched off. `forge_host_off` is a code the
    clone dialog treats as "not asked".
  - A host the probe did not cover falls back to the summary, on purpose.
    Canonicalize both sides (`canonicalForgeHostname`), or a miss lands
    silently on the permissive answer.
- **Capabilities describe the integration, not a login**
  (`FORGE_PRODUCTS[kind].capabilities`): static, no network call.
  `batchedCommitAssociation` is false for GitLab (no batch endpoint); callers
  use it to avoid asking, not to handle a failure.

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
  GitLab transport uses GraphQL; GitHub uses REST. Pass GraphQL *variables*;
  never interpolate.
- The tri-state matches GitHub: an account object resolves; `null` is an
  authoritative "no linked account"; an absent/unreadable commit is
  inconclusive and caches nothing.
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

## Test fixture

- `pwrdrvr/qa/forge/PwrGit-Test` (private, gitlab.com): a nested 4-segment
  path; MRs `!1`–`!6` (opened, draft, closed, merged, squash-merged,
  conflicting); and a branch with no MR.
- The **imported** `pwrdrvr/PwrGit` mirror is *not* a substitute. Its MRs lack
  `merge_commit_sha`/`squash_commit_sha`, so mainline commits resolve to no MR
  and look like a bug here. Use it only for branch→MR at scale.

## Repository metadata: a second seam, deliberately separate

Clone, fork and repo identity marks need other verbs (visibility, fork
lineage, listing, forking). So they use `ForgeRepoProvider`
(`repo-provider.ts`) and do not widen `ForgeProvider`.

Electron E2E replaces this seam only when `PWRGIT_E2E_FORGE_FIXTURE` names a
fixture file. Keep that wiring in `e2e-forge-fixture.ts`. Tests must exercise
the real renderer/IPC/services/indexer, never stub above the provider, and
never reach a real forge.

- **What a forge cannot do belongs in `capabilities`** (`FORGE_PRODUCTS`),
  which Settings → Forges and the dialogs both read. Not a provider property:
  settings would not see it. Example: GitLab's fork API has no
  default-branch-only option, so `forkDefaultBranchOnly` is false and the fork
  dialog hides the switch. An ignored control is worse than none.
- **Availability is `status.ts`'s job.** `ForgeRepoProvider` answers
  `owners()`, nothing about installed/logged-in. `ForgeStatusService` already
  caches one probe for the app; a provider probe would spawn a second.
- **Identity is read from `origin`.** In a fork checkout, `origin` is your fork
  and `upstream` the original; marks describe what you push to. Results persist
  in `repo_identity`, which `RepoIndexer` joins onto `repo:list`, so marks
  paint on the first frame. Refreshes send a `repo:identityChanged` delta the
  renderer patches in place; a full reload would collapse expanded repos.
- **Other remotes are read at the same time, only for naming.** `readRemotes`
  runs one `git remote -v` and stores every forge hostname in
  `RepoIdentity.remoteHostnames` (`repo_identity.remote_hosts`, JSON array). A
  checkout can push to GitHub and mirror to GitLab, so the forge chip shows
  `+n`.
  - **`origin` still means `origin`:** its fetch URL, not a push URL. A
    mirror's visibility and lineage describe a different project.
  - **Leave out a host no product claims.** A NAS remote is not a forge.
  - **NULL means "not known", not "no others"** (row written before the
    column). `persistence/json-string-list.ts` is the one decoder, so
    `IdentityService.read` and `RepoIndexer` agree.
  - `remote:add` / `remote:update` / `remote:remove` refresh identity with
    **`force`**; otherwise the freshness gate holds the chip up to six hours. A
    fetch does not force: it cannot change remotes.
- **A forge host name is display-only.** `ForgeHostConfig.label` (typed in
  Settings → Forges → Hosts) reaches the renderer on `ForgeHostRow`
  **unresolved**. `packages/shared/src/forge-host-name.ts` derives short names
  for unnamed hosts. It reads hostname labels, which is allowed: it gets the
  resolved kind and only picks characters. A wrong name is an ugly chip, not a
  request to the wrong API.
- **The chip usually shows the product's MARK** (`resolveForgeHostDisplays`;
  glyphs in `features/sidebar/ForgeMark.tsx`), so it fits every row of a 320px sidebar.
  Words appear only where the mark cannot answer:
  - a product with two enabled hosts (one Octocat cannot tell `github.com` from
    `ghe.acme.example`, so BOTH are named);
  - a name the user typed;
  - a host no product claims.
  - The tooltip always lists every host.
- **The marks are the vendors' own files, unaltered:** a `Record<ForgeKind, …>`
  in `features/sidebar/ForgeMark.tsx`. Other glyphs are transcribed from Lucide, but
  GitHub and GitLab forbid redrawing their marks. Render them as `<img>` from
  `renderer/src/assets/<vendor>/`; never `currentColor`, a CSS filter,
  or a stretching `width`/`height` pair. The theme picks between the vendor's
  colorway files (`lib/brandTheme.ts`) and never recolors. Read the asset
  READMEs (guidance, provenance, re-download) before you change artwork.
- **Three states, not two.** No `repo_identity` row = *never looked up*.
  `visibility: "unknown"` = *asked, and the forge would not say*. Neither
  collapses into `public`, which would understate where code can go.
  - `viewerCanPush` absent means "could not tell", never `false` (forge does
    not report it, unauthenticated read, or old row). Only an explicit no draws
    the read-only mark or offers a fork. GitHub (`permissions.push`) and GitLab
    (project/group `access_level`) return it in the payload already read;
    GitCafe does not.
  - A signed-out CLI writes **no** row, so sign-in gets a fresh read. A 404
    writes `unknown`, so passes do not re-ask.
  - Successful fetches/pulls request a background refresh under the
    profile-load TTL: six hours for known visibility, five minutes for unknown.
  - Service-wide slots bound overlapping calls (eight Git reads, four forge
    requests). Same-repo lookups coalesce. Signed-out attempts back off five
    minutes in memory, without a row.
  - A click on the sidebar visibility mark forces a refresh of that repo, or
    waits for a running lookup.
  - IPC returns the lookup outcome apart from deltas. A signed-out attempt can
    keep a known identity, and a change to unknown is unresolved. Show success
    feedback only for a resolved outcome.
- **The per-host switch gates the three background readers.** Settings →
  Forges → Hosts writes `enabled`; `ForgeHosts.isEnabled` answers.
  `PrService` and `GitHubCommitAuthorIdentityService` use
  `resolveEnabledForge`/`resolveEnabledForgeRepo` (`index.ts`).
  `IdentityService` takes a required `ForgeHostGate`. Grep `isEnabled` to find
  all three.
  - **The gate reads the `source`.** Both "off" cases stamp `gateRetryAfter`
    (no row is written, so the repo would otherwise be due every pass).
    Config/env "off" is a decision: identity-TTL window, reported as
    `host_disabled`. `auto` "off" means no CLI reported the host *yet* (the two
    enumeration subprocesses land after the first refresh): short retry
    window, reported as `unavailable`. A long `auto` backoff hides marks for
    hours; a short decided backoff re-reads every remote every five minutes.
  - **The `due` filter checks freshness, never the gate.** Checking the stored
    hostname (the last host that *answered*) froze any repo whose `origin`
    moved to an enabled host. Only `gateRetryAfter`, which expires, suppresses
    a switched-off host.
  - **Anything that can change the gate's answer calls `clearGateBackoff()` and
    refreshes.** In `index.ts` this is the single hook
    `onForgeTargetsMaybeMoved`, fed by boot enumeration, the Hosts pane's
    Re-check, `forgeStatus.onChange`, and every settings write. It guards on
    `forgeTargetSignature` and debounces; without the guard, every settings
    write re-read `origin` for the whole profile. These edges land after the
    profile-load refresh, and the sidebar glyph (the only manual trigger) does
    not render without a row.
    - It refreshes **every open profile**, not `getActiveId()`. Unfocused
      profile windows otherwise lost their backoff and got no repaint.
    - It `await`s `identityService.settled()` first. A running pass holds every
      repo in-flight, and the unforced `due` filter drops them.
  - **The two "do not ask again" stamps are separate maps.** Signed-out: short
    window, cleared only by a successful read; clearing it on a settings write
    spawns a burst against a logged-out CLI. Switched-off: the settings write
    clears it; its identity-TTL window only re-notices a re-pointed `origin`.
    At the short window, 300 repos cost ~3,600 `git remote` spawns an hour.
- **Switching a host off stops the asking; it keeps what was asked.** The
  `repo_identity` row stays and renders, and the refresh reports
  `host_disabled` with it. Deleting would turn *asked, and private* into
  *never looked up*, and would lose facts when an env allowlist turns a host
  off for one session. Re-enabling repaints from a fresh read.
- `host_disabled` is the only non-resolved outcome that is a **choice**.
  `unavailable` = could not ask; `unknown` = asked, no answer. The refresh
  button must not report a choice as a failure.
- **Clone and fork are gated on their own instance, not the SaaS one.** They
  were once ungated, then gated only on github.com/gitlab.com while acting on
  the request's hostname. `forgeBlockAt` fixed both, and `status.ts` does not
  probe disabled hosts. So "off" covers every reader and both writers. The
  settings copy must not promise more than that.
- **A dialog opens on local state; ask a forge only on debounced input.**
  `repo:cloneCatalog` once ran `gh repo list <owner> --limit 200` per owner on
  open; sixteen owners showed "Loading repositories…" for **13 seconds**. Now
  it answers from `repo_identity` and the cached probe (~0ms forge work).
  `repo:searchCloneSources` runs `gh search repos` / GitLab project search once,
  300ms after input settles.
  - **No "list everything" verb on `ForgeRepoProvider`.** `searchRepos` takes a
    term and owners together, so nobody calls a whole-inventory list N times.
  - **One owner-scoped call, never one per owner.** `gh search repos` repeats
    `--owner=`. GitLab cannot, so several owners become one instance-wide
    search, narrowed afterwards. An empty term with several owners is declined.
  - **`owner/term` scopes the search.** `pwrdrvr/micro` would only 404 the
    exact check, so it also runs as an owner-scoped search.
- **Answer "which local checkouts are this repository?" from SQLite.** Spawning
  `git remote -v` in every indexed repo cost 52 subprocesses per call on a
  mid-size profile. `localForgeState` (clone-service) and `checkoutsFor`
  (fork-service) read `Repo.identity`. Its fork parents keep the owner list as
  wide as the old `upstream`-remote scan.
- **Loading is not unavailable.** The fork dialog once showed its in-flight
  catalog as "install the GitHub CLI". `sourceEmptyMessage` owns that wording,
  and a test pins it.
- **GitLab says groups, not organizations.** `ownerKindLabel` reads the
  product's `organizationNoun` (see [gitlab/AGENTS.md](gitlab/AGENTS.md)).

## Published SSH server keys

- `ssh-host-keys.ts` is a separate, per-host `ForgeSshHostKeyProvider`
  registry of server identity keys, never account/deploy keys.
- A provider returns an HTTPS source and full keys, `null` when no source is
  known, or throws when the source cannot be retrieved or parsed.
- Never substitute `ssh-keyscan` for a published source. Never apply SaaS keys
  to another hostname/port.
- GitCafe has no verified publication endpoint. Keep its provider unknown until
  one is documented.
