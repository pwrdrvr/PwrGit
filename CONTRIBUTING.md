# Contributing to PwrGit

Thanks for helping improve PwrGit. The project is MIT-licensed; by submitting a
contribution, you agree that it may be distributed under that license.

Use [GitHub Issues](https://github.com/pwrdrvr/PwrGit/issues) for reproducible
bugs and focused feature proposals. Do not report vulnerabilities publicly;
follow [SECURITY.md](SECURITY.md) instead.

## Development setup

PwrGit is a pnpm workspace. It requires Node.js 24 through nvm (the version in
`.nvmrc`) and uses the pnpm version pinned in the root `package.json`. A fresh
checkout or worktree needs its own install:

```bash
git clone https://github.com/pwrdrvr/PwrGit.git
cd PwrGit
source ~/.nvm/nvm.sh
nvm install
nvm use
corepack enable
pnpm install
pnpm dev
```

Do not assume `nvm` is initialized in a non-interactive shell. Installing with
the wrong Node version can compile `better-sqlite3` for the wrong ABI and cause
later test or launch failures. A root `preinstall` guard refuses an install
under the wrong Node.

One install prepares `better-sqlite3` for both Node-based tests and Electron,
so `pnpm test` and `pnpm dev` need no rebuild between them. If a native-module
ABI error appears anyway, repair the stale half with:

```bash
pnpm --filter @pwrgit/desktop run rebuild:electron-native
```

Do not run a root-level `pnpm rebuild better-sqlite3`; the dependency belongs
to the desktop package and that command silently misses it.

### Linux: Electron's sandbox helper

On Linux, install and launch warn if Electron's setuid sandbox helper lacks
root ownership and mode `4755`. The warning is advisory — user namespaces may
allow launch without it. If launch reports the SUID sandbox error, run:

```bash
pnpm fix:linux-sandbox
pnpm dev
```

The fixer resolves this checkout's Electron helper and uses `sudo` only for its
ownership and permissions; run PwrGit as your normal user, and do not disable
its sandbox. Repeat after Electron is replaced if needed.
`pnpm check:linux-sandbox` repeats the advisory check. Mount policy and user
namespaces can also affect sandbox availability. This is a development-checkout
fix; it does not touch an installed package.

## Repository map

- `apps/desktop` — Electron main, preload, renderer, packaging, and desktop
  end-to-end tests.
- `packages/shared` — the only shared contracts allowed across desktop process
  boundaries.
- `packages/mcp-server` — the local-agent MCP server, runnable standalone over
  stdio or inside the desktop app.
- `scripts` — repository-wide policy, license, and release checks.
- `docs` — contributor and operator documentation.

Read the root [AGENTS.md](AGENTS.md) and any nearer `AGENTS.md` before changing
code in a scoped directory. Those files contain the current architectural and
runtime constraints.

## How it's built

| Layer | Stack | Where it lives |
|---|---|---|
| Desktop shell | Electron + TypeScript + React + electron-vite | `apps/desktop/` |
| Git runtime | Dugite with bundled Git and Git LFS (plus Git Credential Manager on Windows); an installed Git can be selected in Settings | `apps/desktop/src/main/git/` |
| Forge integrations | GitHub and GitLab providers through `gh` and `glab` | `apps/desktop/src/main/forge/` |
| AI features | Opt-in, per profile; drives the operator's own Codex CLI (ACP agents are discovered but no job runs on them yet) | `apps/desktop/src/main/ai/` |
| Local state | SQLite through `better-sqlite3` | `apps/desktop/src/main/persistence/` |
| Shared contracts | Typed commands, events, domain types, and result envelopes | `packages/shared/` |
| Local agent access | MCP over OAuth-protected loopback HTTP or standalone stdio, subscribable status resources, optional loopback WebSocket | `packages/mcp-server/` |

## Checks

Run the checks relevant to your change from the repository root:

```bash
pnpm lint
pnpm test
pnpm build
pnpm test:desktop-e2e
```

`pnpm lint` runs every check CI's Typecheck job runs, cheapest first: forge-kind
branching, the color-token policy, the dependency release-age cooldown,
third-party license checks, dependency boundaries, and workspace typecheck. Add
a new repository-wide check to that chain in the root `package.json`, not as a
separate CI step. The end-to-end suite builds the Electron app before
Playwright starts it.

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

## Local agent access (MCP)

**Settings → Local Agents** enables local-agent access and shows the connection
commands. The desktop app serves OAuth-protected MCP at
`http://127.0.0.1:51731/mcp`; the operator approves each client's Session Name
and role in PwrGit's native window, and the app must stay running for HTTP
clients. Standalone stdio clients do not need the app running but cannot see
profiles or navigation.

Tools, the authorization policy, repository boundaries, the live-status
resources, revocation, and the WebSocket fallback are documented in
[docs/mcp-server.md](docs/mcp-server.md).

## Releases

Releases are cut by pushing a `vX.Y.Z` tag that matches
`apps/desktop/package.json` and a `CHANGELOG.md` section; `pnpm release:check`
verifies both. The tag suffix picks the update channel: none is Stable Latest,
`-prerelease` Stable Prerelease, `-beta` Beta Latest, `-alpha` Beta
Prerelease.

The guarded pipeline — Apple signing and notarization, Azure Artifact Signing
for Windows, update metadata, Linux DEB/RPM/pacman/tar.gz packaging and its
runtime gates, and stable-name download aliases — is documented in
[docs/desktop-release-runbook.md](docs/desktop-release-runbook.md). CI, preview
builds, and signing secrets are in
[.github/workflows/README.md](.github/workflows/README.md); Homebrew and Winget
publication are in
[docs/package-manager-distribution.md](docs/package-manager-distribution.md).

The README's download chips come from
`apps/desktop/scripts/generate-readme-chips.swift` (run from `apps/desktop`);
edit its chip list rather than the PNGs in `docs/assets/buttons/`.

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

## Further reading

| Doc | What it covers |
|---|---|
| [docs.pwrgit.com](https://docs.pwrgit.com) | Operator reference: setup, features, settings, troubleshooting. |
| [AGENTS.md](AGENTS.md) | Load-bearing architecture, native-module, launch, and release guidance. |
| [docs/mcp-server.md](docs/mcp-server.md) | Local agent tools, safe discovery, live-status resources, and fallback event protocol. |
| [docs/repository-maintenance.md](docs/repository-maintenance.md) | Garbage collection, merged-branch cleanup, and retention behavior. |
| [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md) | Guarded CI release path, signing environments, assets, and promotion. |
| [docs/third-party-license-notices.md](docs/third-party-license-notices.md) | Generated dependency notices and embedded Git attribution. |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes in each release. |

## Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not report vulnerabilities in public issues or pull requests. Use GitHub
private vulnerability reporting, or email security@pwrdrvr.com. The full
policy, including what to put in a report, is in [SECURITY.md](SECURITY.md).
