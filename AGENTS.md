# AGENTS.md

Guidance for coding agents (and humans) in PwrGit — a cross-platform Electron
git client in the Pwr family (siblings: PwrSnap, PwrAgnt). Keep this file short;
see **Docs & conventions** below.

## Set up a new checkout or worktree

Enter the repo through nvm, then install. **Do not assume `nvm` is
initialized** — it is a shell function, and a non-interactive agent shell
usually does not have it, so `node` is whatever the machine defaults to:

```bash
source ~/.nvm/nvm.sh   # agent shells: nvm is undefined until you source it
nvm install            # first time on a machine
nvm use                # reads .nvmrc (Node 24)
pnpm i                 # every fresh checkout/worktree needs its own
```

A root `preinstall` guard ([scripts/check-node-version.mjs](scripts/check-node-version.mjs))
fails the install under a Node that does not match `.nvmrc`, or one that is not
nvm's on a machine that has nvm. Native modules are compiled against the ABI of
whichever Node ran the install, and a wrong-ABI build does not announce itself:
it surfaces much later as a test failure or a launch crash that reads like a
broken database.

One `pnpm i` serves both runtimes. It leaves separate `better-sqlite3` artifacts
for this machine's Node (what `vitest` loads) and Electron (what the app loads),
both staged from the package's ABI-independent Node-API prebuild, so `pnpm test`
and `pnpm dev` need no rebuild between them, in either order.
`apps/desktop/AGENTS.md` describes the layout. If a
native ABI error
does appear — *"better_sqlite3.node was compiled against a different Node.js
version using NODE_MODULE_VERSION 147; this version requires 145"* — one
command repairs whichever half is stale:

```bash
pnpm --filter @pwrgit/desktop run rebuild:electron-native
```

Never `pnpm rebuild better-sqlite3` from the repo root: better-sqlite3 is a
desktop dependency, not a root one, so the root rebuild silently no-ops.
`require("better-sqlite3")` keeps working afterwards and only `new Database()`
fails, which is a confusing place to start debugging.

## Common commands

```bash
pnpm dev        # run the app (electron-vite dev)
pnpm build      # production build
pnpm test       # vitest across the workspace
pnpm typecheck  # tsc across packages
pnpm lint       # every check CI runs, cheapest-first (see below)
```

`pnpm lint` chains `lint:colors` → `licenses:check` → `lint:boundaries` →
`typecheck`, ordered so a fast failure doesn't wait on the slow one. CI's
Typecheck job runs exactly this one command, so **add new repo-wide checks to
the chain in the root `package.json`**, not as another CI step.

`licenses:check` chains three scripts that are easy to mistake for each other;
[scripts/AGENTS.md](scripts/AGENTS.md) says which one judges a dependency's
license and which two do not. **Adding a dependency under an unfamiliar license
is a legal decision — read that file before making the build green.**

`lint:boundaries` is dependency-cruiser (`.dependency-cruiser.cjs`). It enforces
that main, preload, and renderer stay three separate bundles sharing only
`@pwrgit/shared` — violations there type-check and usually bundle, then fail at
launch, so `tsc` will not catch them. The config's header comments explain each
rule.

## Launch the dev app

Prefer the **Dev** action from `.codex/environments/environment.toml`. It is the
canonical launch path: from the repository root it runs `nvm use --silent`,
enables Corepack, and then runs the root `pnpm dev` script.

Before launching, check whether a window titled `PwrGit` already exists and
reuse it when suitable. Do not launch an Electron binary directly or start a
second isolated PwrGit instance for ordinary visual verification; if a launch
is required, use the canonical path above or the fallback below.

For Computer Use, never target the generic `Electron` display name or shared
`com.github.Electron` bundle ID. Resolve the running PwrGit window and process,
then target its exact Electron app path. Confirm that executable belongs to
PwrGit—not PwrAgent, PwrSnap, or another checkout or project.
If it cannot be identified unambiguously, stop instead of guessing.

Agent shells hosted by another Electron Pwr app can inherit that parent's
`ELECTRON_EXEC_PATH`, `ELECTRON_CLI_ARGS`, or `ELECTRON_MAJOR_VER`. Running
Electron with those overrides can silently launch PwrGit through a sibling
app's Electron installation. If the Dev action is unavailable, first confirm
that the active `node` matches `.nvmrc`. Do not assume `nvm` is initialized in a
non-interactive agent shell. With the correct Node already active, mirror the
rest of the action while clearing only those launch overrides:

```bash
node --version # must match .nvmrc
corepack enable
env -u ELECTRON_EXEC_PATH -u ELECTRON_CLI_ARGS -u ELECTRON_MAJOR_VER pnpm dev
```

If the Node version is wrong and `nvm` is unavailable, use the canonical Dev
action instead of improvising another Electron launch path.

The resulting Electron executable must come from this PwrGit worktree's
`node_modules`, and its user-data directory must be PwrGit's—not PwrAgent's or
another sibling app's. If either is wrong, stop the process you just started
and relaunch with the canonical action or clean command above.

## Packaging & releases

Packaging goes through `apps/desktop/scripts/release.mjs` (pnpm-deploy stage →
electron-builder; `pnpm --filter @pwrgit/desktop package:dryrun` for a local
unsigned DMG). Releases are cut by pushing a `vX.Y.Z` tag that matches
`apps/desktop/package.json` and a `CHANGELOG.md` section (`pnpm release:check`
verifies). Tag suffixes map onto Settings → Updates: no suffix is Stable
Latest, `-prerelease` is Stable Prerelease, `-beta` is Beta Latest, `-alpha`
is Beta Prerelease. CI, preview builds, and signing secrets are documented in
`.github/workflows/README.md`.

## Pull Requests

- Prefer before/after screenshots on PRs that change visible UI.
  - Use 100% contrived fixture data when possible.
  - If a screenshot is not 100% contrived, show it to the operator and wait for approval before attaching. Redact anything that must not ship (secrets, tokens, customer data, private thread text, account identifiers).
- GitHub CLI 2.99+ (`gh` v2.99.0) can attach images and videos with the repeatable `--attach` flag on `gh pr create`, `gh pr edit`, and `gh pr comment`.
  - Reference the local path in the Markdown body so `gh` rewrites it to the uploaded URL in place. Unreferenced attachments are appended at the end.
  - Example:

    ```bash
    gh pr create \
      --title "fix(desktop): tighten sidebar padding" \
      --body-file /tmp/pr-body.md \
      --attach ./before.png \
      --attach ./after.png
    ```

    With this body:

    ```markdown
    ## Before
    ![sidebar before](./before.png)

    ## After
    ![sidebar after](./after.png)
    ```

  - Alt text can also follow the path after `#`, as in `--attach './after.png#sidebar after'`. Update `gh` to v2.99.0 or later before using `--attach`.

## Docs & conventions

- **Agent guidance lives in `AGENTS.md`** — not in READMEs or human-facing code
  comments.
- **Progressive disclosure — short and close.** Put guidance in the smallest
  scope that needs it: a nested `AGENTS.md` beside the code it governs, not one
  giant root file. An agent editing `apps/desktop/src/main/**` should find
  main-process notes there; someone touching only `packages/shared` shouldn't
  have to read desktop build lore. Keep every `AGENTS.md` brief — the goal is
  that an agent reads only what's on the path to the file it's changing.
- **Always symlink `CLAUDE.md → AGENTS.md`.** Whenever you add an `AGENTS.md`,
  create a sibling `CLAUDE.md` symlink to it (`ln -s AGENTS.md CLAUDE.md`) so
  both toolchains read one source of truth.
