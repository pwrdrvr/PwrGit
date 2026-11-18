# Repository metadata seam

This guide covers `ForgeRepoProvider`, the second forge seam that clone, fork and repository identity marks use.

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
- **gh's default repository follows gh's rule, not ours.** Without
  `gh repo set-default` (`remote.<name>.gh-resolved`), a non-interactive `gh`
  picks by remote NAME (`upstream` > `github` > `origin` > others). In a fork
  checkout that sends `gh pr create` to the original repository.
  `@pwrgit/mcp-server/gh-default` is the one copy of that rule. The MCP tool
  `pwrgit_repository_info` and `repo:setup` (header chip, Repository setup ›
  GitHub CLI) both call it. When gh changes, re-check it against real gh with
  `PWRGIT_GH_ORACLE=1` (`gh-default.oracle.test.ts`).
  - **Write the key only on a click** (`repo:setGhDefault`: the moved-on
    prompt's checkbox, "Use for gh"). It is shared `.git/config`. It clears
    every `gh-resolved` key, then writes `base` where gh would
    (`planGhSetDefault`).
  - **gh does not hear "Pull from origin only".** That answer is in renderer
    localStorage (`pull-choice.ts`). `ghDefaultNotice` (shared) compares it
    with gh's target, so a default once set to `upstream` still warns. The MCP
    server cannot see the answer, only the key.
  - `gh-default.model.test.ts` drives remotes, gh's own writes, PwrGit's
    writes and the answer against real Git. Extend it for any new path that
    changes either side.
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
  product's `organizationNoun` (see [gitlab/AGENTS.md](../../../apps/desktop/src/main/forge/gitlab/AGENTS.md)).
