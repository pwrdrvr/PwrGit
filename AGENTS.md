# AGENTS.md

Guidance for coding agents (and humans) in PwrGit — a cross-platform Electron
git client in the Pwr family (siblings: PwrSnap, PwrAgnt). Keep this file short;
see **Docs & conventions** below.

## Set up a new checkout or worktree

PwrGit bundles native modules (`better-sqlite3`, and dugite's git). Native
modules compile against the **Node ABI that is active at install time**, but the
app runs them inside **Electron**. Use the Node version Electron ships — pinned
in `.nvmrc` (Node 24) — so the installed binary matches Electron's ABI:

```bash
nvm install   # first time on a machine
nvm use       # reads .nvmrc → Node 24
pnpm i
```

Skip `nvm use` and install under a different Node, and the app fails to launch
with an ABI mismatch like:

> Error: The module '…/better_sqlite3.node' was compiled against a different
> Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
> requires NODE_MODULE_VERSION 139.

The fix is always the same: `nvm use && pnpm i` to rebuild the native module for
the correct ABI. (Same story per worktree — each fresh checkout needs one
`nvm use && pnpm i`.)

## Common commands

```bash
pnpm dev        # run the app (electron-vite dev)
pnpm build      # production build
pnpm test       # vitest across the workspace
pnpm typecheck  # tsc across packages
```

## Docs & conventions

- **Agent guidance lives in `AGENTS.md`** — not in READMEs or human-facing code
  comments.
- **Progressive disclosure — short and close.** Put guidance in the smallest
  scope that needs it: a nested `AGENTS.md` beside the code it governs, not one
  giant root file. An agent editing `apps/desktop/src/main/**` should find
  main-process notes there; someone touching only `packages/shared` shouldn't
  have to read desktop build lore. Keep every `AGENTS.md` brief — if a section
  only matters to one directory, move it there. The goal is that an agent reads
  only what's on the path to the file it's changing.
- **Always symlink `CLAUDE.md → AGENTS.md`.** Whenever you add an `AGENTS.md`,
  create a sibling `CLAUDE.md` symlink to it (`ln -s AGENTS.md CLAUDE.md`) so
  both toolchains read one source of truth.
