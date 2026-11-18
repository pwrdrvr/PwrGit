# Forge hosts and status

This guide covers how forge hosts are enumerated and resolved, and how forge status, capabilities and the per-host switch decide who may call a forge.

Code paths in backticks are relative to [apps/desktop/src/main/forge](../../../apps/desktop/src/main/forge/).

## Forge hosts

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
  persists under a key no lookup matches. Reads canonicalize too: a
  hand-edited `www.gitlab.com` key once reached `overrides()` but not
  `kindFor`, and a one-`www.` strip in `classifyForgeHost` missed
  `www.www.host`.
- **Every surface gives one answer per host.** Hosts rows, the Forges card,
  `resolveForgeRepo`, the clone/fork dialogs and the MCP server must agree on
  `kindFor(host)` and on "signed in at host".
  `renderer/.../settings/forge-surfaces.property.test.ts` generates hosts,
  sign-ins, settings and env and checks every one against `ForgeHosts`. A new
  surface that names a product or a sign-in goes in that test.
  - A row is `origin: "cli"` only when **its own product's** CLI reported the
    host. A host `gh` reports that config gives to GitLab is a `config` row.

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
- **An `assumed` target is probed, and reported apart from the rows.** The
  backfilled SaaS host has no Hosts row, so `ForgeStatus.hosts` omits it.
  Listing it there would show a host the user cannot switch, and `every` could
  never clear to "Off". It is `ForgeStatus.assumedHost` instead, which
  `forgeBlockAt` reads. Without it, an env-switched-off or signed-out
  github.com fell through to the forge-wide summary and a GHE sign-in let a
  clone through. It is probed **without naming a host**, because
  `--hostname github.com` overrides `GH_HOST`/`GITLAB_HOST` (see
  `../github/pr-client.ts`). Its credential counts toward the summary.
  - A SaaS host is assumed only for the product it resolves to.
    `PWRGIT_GITHUB_HOSTS=gitlab.com` gives GitLab no gitlab.com target, or
    the card says "GitLab: Connected" for a host every route sends to GitHub.
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
