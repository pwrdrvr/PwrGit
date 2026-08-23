# Contributing to PwrGit

Thanks for helping improve PwrGit. The project is MIT-licensed; by submitting a
contribution, you agree that it may be distributed under that license.

Use [GitHub Issues](https://github.com/pwrdrvr/PwrGit/issues) for reproducible
bugs and focused feature proposals. Do not report vulnerabilities publicly;
follow [SECURITY.md](SECURITY.md) instead.

## Development setup

PwrGit requires Node.js 24 through nvm and uses the pnpm version pinned in the
root `package.json`. A fresh checkout or worktree needs its own install:

```bash
source ~/.nvm/nvm.sh
nvm install
nvm use
corepack enable
pnpm install
pnpm dev
```

Do not assume `nvm` is initialized in a non-interactive shell. Installing with
the wrong Node version can compile `better-sqlite3` for the wrong ABI and cause
later test or launch failures.

If that native-module error appears, repair the Electron side with:

```bash
pnpm --filter @pwrgit/desktop run rebuild:electron-native
```

Do not run a root-level `pnpm rebuild better-sqlite3`; the dependency belongs
to the desktop package and that command silently misses it.

## Repository map

- `apps/desktop` — Electron main, preload, renderer, packaging, and desktop
  end-to-end tests.
- `packages/shared` — the only shared contracts allowed across desktop process
  boundaries.
- `scripts` — repository-wide policy, license, and release checks.
- `docs` — contributor and operator documentation.

Read the root [AGENTS.md](AGENTS.md) and any nearer `AGENTS.md` before changing
code in a scoped directory. Those files contain the current architectural and
runtime constraints.

## Checks

Run the checks relevant to your change from the repository root:

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:desktop-e2e
```

`pnpm lint` runs the color-token policy, third-party license checks, dependency
boundaries, and workspace typecheck. The end-to-end suite builds the Electron
app before Playwright starts it.

For a documentation-only change, `pnpm lint` is the expected baseline. If you
skip a broader check, explain why in the pull request.

## Architecture and conventions

- Keep Electron main, preload, and renderer as separate bundles. Shared code
  belongs in `@pwrgit/shared`; dependency-cruiser enforces the allowed graph.
- Route cross-process actions through the typed command bus and return the
  shared `Result` shape instead of throwing across IPC.
- Keep renderer windows sandboxed with context isolation enabled and Node
  integration disabled.
- Preserve profile, repository, and worktree data across forward migrations.
- Use the injected Git execution layer in main-process Git code so production
  uses Dugite while tests can use controlled executors.

## Pull requests

- Keep each PR focused on one coherent change.
- Use a Conventional Commit-style title: `type(scope): description`.
- Prefer `desktop`, `git`, `forge`, `release`, `docs`, or `tests` when one of
  those scopes describes the change.
- Include tests for behavior changes, or state why the change is
  documentation-only.
- Record the commands and manual checks you ran.
- Preserve unrelated work already present in the checkout.

If a dependency or bundled runtime changes, regenerate and review the committed
notices:

```bash
pnpm licenses:generate
pnpm licenses:check
```

See [docs/third-party-license-notices.md](docs/third-party-license-notices.md)
for the notice scope and embedded Git requirements.

## Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
