# AGENTS.md

Guidance for coding agents (and humans) in PwrGit — a cross-platform Electron
git client in the Pwr family (siblings: PwrSnap, PwrAgnt). Keep this file short;
see **Docs & conventions** below.

## Set up a new checkout or worktree

PwrGit bundles a native module (`better-sqlite3`) that must match **Electron's**
ABI — which is *not* the same as any plain Node's (Electron 41 ≠ Node 24/26).
`pnpm i` handles this: a `postinstall` runs `electron-rebuild` to compile native
modules for the bundled Electron. Use the Node in `.nvmrc` for consistency, then
install:

```bash
nvm install   # first time on a machine
nvm use       # reads .nvmrc (Node 24)
pnpm i        # installs, then postinstall rebuilds native modules for Electron
```

Each fresh checkout/worktree needs its own `pnpm i`.

If the app fails to launch with an ABI mismatch — e.g. *"better_sqlite3.node was
compiled against a different Node.js version using NODE_MODULE_VERSION 147; this
version requires 145"* — the native build is stale. Fix with `pnpm i`, or
`pnpm --filter @pwrgit/desktop run rebuild:electron-native`.

**Running tests:** `vitest` runs under Node, not Electron, so the SQLite unit
tests need a **Node-ABI** build first: `pnpm rebuild better-sqlite3`. Restore the
Electron build with `pnpm i` before running the app again. (Both ABIs can't
coexist in one `node_modules` — rebuild for whichever runtime you're about to
use.)

## Common commands

```bash
pnpm dev        # run the app (electron-vite dev)
pnpm build      # production build
pnpm test       # vitest across the workspace (needs a Node-ABI native build)
pnpm typecheck  # tsc across packages
```

## Packaging & releases

Packaging goes through `apps/desktop/scripts/release.mjs` (pnpm-deploy stage →
electron-builder; `pnpm --filter @pwrgit/desktop package:dryrun` for a local
unsigned DMG). Releases are cut by pushing a `vX.Y.Z` tag that matches
`apps/desktop/package.json` and a `CHANGELOG.md` section (`pnpm release:check`
verifies). CI, preview builds, and signing secrets are documented in
`.github/workflows/README.md`.

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
