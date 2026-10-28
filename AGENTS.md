# AGENTS.md

Guidance for coding agents (and humans) in PwrGit, a cross-platform Electron
git client in the Pwr family (siblings: PwrSnap, PwrAgnt). Nested `AGENTS.md`
files beside the code carry the detail; read the ones on the path to what you
change.

## Rules that always apply

1. **`source ~/.nvm/nvm.sh && nvm use` before `pnpm i`, tests or builds.**
   Agent shells don't have nvm loaded, and a wrong-Node install fails later as
   a broken test or database, not at install. Each checkout/worktree needs its
   own `pnpm i`.
2. **Run `pnpm lint` before pushing.** It is exactly what CI's Typecheck job
   runs. New repo-wide checks go in its chain in the root `package.json`, not
   in a new CI step.
3. **A PR that changes visible UI has before/after screenshots** with
   contrived data. You don't need the live app:
   [docs/pr-screenshots.md](docs/pr-screenshots.md) covers harness renders,
   `design-shots.spec.ts`, and `gh --attach`. "Not launched" is not a reason to
   skip. If nothing can show the change, say why and ask the operator.
4. **Never make CI green by adding a `minimumReleaseAgeExclude` entry or a
   license id.** Both are supply-chain or legal decisions; read
   [scripts/AGENTS.md](scripts/AGENTS.md) first.
5. **Never launch Electron directly or target the generic `Electron` app.**
   See [Launch the dev app](#launch-the-dev-app).
6. **Every new `AGENTS.md` gets a sibling `CLAUDE.md` symlink**
   (`ln -s AGENTS.md CLAUDE.md`).

## Set up a checkout or worktree

```bash
source ~/.nvm/nvm.sh   # nvm is a shell function; agent shells lack it
nvm install            # first time on a machine
nvm use                # reads .nvmrc (Node 24)
pnpm i
```

A `preinstall` guard ([scripts/check-node-version.mjs](scripts/check-node-version.mjs))
refuses a Node that doesn't match `.nvmrc`. One `pnpm i` stages
`better-sqlite3` for both this Node (vitest) and Electron (the app), so
`pnpm test` and `pnpm dev` need no rebuild between them
([apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) has the layout). If you see
*"better_sqlite3.node was compiled against a different Node.js version"*, run:

```bash
pnpm --filter @pwrgit/desktop run rebuild:electron-native
```

Never `pnpm rebuild better-sqlite3` from the repo root. It silently no-ops
(the package is a desktop dependency), and only `new Database()` fails
afterwards.

Don't share `node_modules` between worktrees: workspace imports resolve into
the donor checkout, and installs mutate its dependencies.

**Linux:** if Electron reports the fatal SUID sandbox error, run
`pnpm fix:linux-sandbox` (sudo for chown/chmod only). Don't run the app as
root or disable its sandbox. The install-time warning alone is advisory.
Re-run the fix after Electron is replaced.

## Common commands

```bash
pnpm dev        # run the app (electron-vite dev)
pnpm build      # production build
pnpm test       # vitest across the workspace
pnpm typecheck  # TypeScript 7 native compiler across packages
pnpm lint       # every check CI runs, cheapest-first
```

`pnpm lint` chains `lint:syntax` → `lint:forge-kinds` → `lint:colors` →
`deps:maturity` → `licenses:check` → `lint:boundaries` → `typecheck`.

- `deps:maturity` enforces the seven-day dependency cooldown;
  `licenses:check` gates every shipped license.
  [scripts/AGENTS.md](scripts/AGENTS.md) explains both, and which of the three
  license scripts actually judges a dependency.
- `lint:boundaries` (dependency-cruiser, `.dependency-cruiser.cjs`) keeps main,
  preload and renderer separate bundles sharing only `@pwrgit/shared`.
  Violations type-check and bundle, then fail at launch.
- `typecheck` is the unused-code gate (`noUnusedLocals` /
  `noUnusedParameters`). Two blind spots: a leading `_` exempts parameters
  *and imports* (don't use it to hide a dead import), and an export nobody
  imports is never flagged (grep for a symbol after deleting its last import).
  An unused binding in a test is often a missing assertion. Compiler selection
  (TS7 vs TS6) is in [scripts/AGENTS.md](scripts/AGENTS.md).

E2E needs a build (`pnpm build`) and has its own guide:
[apps/desktop/e2e/AGENTS.md](apps/desktop/e2e/AGENTS.md). For headed E2E in
the lab VM, read [docs/headed-e2e-pwrsuitelab.md](docs/headed-e2e-pwrsuitelab.md)
first.

## Launch the dev app

Several Pwr Electron apps and checkouts run on this machine at once, so it is
easy to drive the wrong one.

- Reuse an existing `PwrGit` window when suitable. Otherwise launch with the
  **Dev** action in `.codex/environments/environment.toml`
  (`nvm use --silent`, `corepack enable`, `pnpm dev`). Don't start a second
  isolated instance just to look at something.
- For Computer Use, never target the generic `Electron` name or
  `com.github.Electron`. Resolve the PwrGit window's exact Electron app path
  and confirm it belongs to this checkout. If you can't tell, stop.
- Shells hosted by another Pwr app can inherit `ELECTRON_EXEC_PATH`,
  `ELECTRON_CLI_ARGS` or `ELECTRON_MAJOR_VER`, which silently launch PwrGit
  through a sibling's Electron. Without the Dev action, with `node --version`
  matching `.nvmrc`:

  ```bash
  corepack enable
  env -u ELECTRON_EXEC_PATH -u ELECTRON_CLI_ARGS -u ELECTRON_MAJOR_VER pnpm dev
  ```

  If the Electron binary isn't from this worktree's `node_modules`, or the
  user-data directory isn't PwrGit's, stop that process and relaunch.

## Packaging & releases

Packaging goes through `apps/desktop/scripts/release.mjs`
(`pnpm --filter @pwrgit/desktop package:dryrun` builds a local unsigned DMG).
A release is a pushed `vX.Y.Z` tag matching `apps/desktop/package.json` and a
`CHANGELOG.md` section (`pnpm release:check`). Tag suffixes: none = Stable
Latest, `-prerelease` = Stable Prerelease, `-beta` = Beta Latest, `-alpha` =
Beta Prerelease. CI, preview builds and signing:
`.github/workflows/README.md`. The macOS icon needs Xcode 26's actool; see
"macOS app icon" in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).

## Docs & conventions

- Agent guidance lives in `AGENTS.md`, not in READMEs or code comments.
- Put it in the smallest scope that needs it: a nested `AGENTS.md` beside the
  code it governs. Long operator procedures go in `docs/`, with a one-line
  pointer that says when to read them. Keep every `AGENTS.md` brief.
- Symlink `CLAUDE.md → AGENTS.md` beside every `AGENTS.md`.
