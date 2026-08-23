# PwrGit

**Git for people working alongside an agent.**

A desktop Git client for macOS and Windows, built around worktrees. Every
repository you have checked out lives in one window, and every branch you are
working on can have its own directory — so a long build, a running test suite,
or something else editing one branch leaves the branch you are reading alone.
The lineage graph draws what actually happened, including the commits a branch
is missing. Pull- and merge-request status comes from the `gh` or `glab` CLI
you already signed in with: PwrGit never asks for a password and stores no token
of its own. Git ships inside the app. No account, no telemetry, no PwrGit
server.

<p>
  <a href="https://github.com/pwrdrvr/PwrGit/releases/latest/download/PwrGit.dmg">
    <img src="docs/assets/buttons/download-macos.png" alt="Download for macOS" width="440">
  </a>
  &nbsp;
  <a href="https://docs.pwrgit.com">
    <img src="docs/assets/buttons/read-the-docs.png" alt="Read the docs" width="440">
  </a>
</p>

## Why you might want it

- **Worktrees are part of the model, not an afterthought.** Repositories and
  their linked worktrees live together in the sidebar. Create, remove, pin,
  reorder, and move between them without losing which checkout owns which
  branch.
- **History answers the question you actually have.** The Lineage graph brings
  local and remote branches, worktrees, pull requests, merge requests, and
  upstream state into one view. Search by message, branch, repository, or exact
  SHA instead of scrolling through a decorative log.
- **Changes stay close to context.** Review text and image diffs, stage or
  unstage files and folders, add noisy paths to `.gitignore`, commit or amend,
  and discard with confirmation — without leaving the selected worktree.
- **Sync failures become decisions.** Fetch, pull, and push have visible
  progress. When branches diverge, PwrGit inspects the state first and offers a
  deliberate rebase or reset path instead of handing you a generic failure.
- **Clone and fork without giving up the forge.** Search and clone repositories,
  create forks, see public/private/internal identity marks, and surface GitHub
  PR or GitLab MR status through authenticated `gh` and `glab` installations.
- **Profiles keep separate worlds separate.** Each profile has its own roots
  and window. Repository and worktree state stays in a local SQLite database,
  while packaged builds run Git through the bundled runtime.

The longer-form pitch lives at **[pwrgit.com](https://pwrgit.com)**; setup,
features, and troubleshooting live at
**[docs.pwrgit.com](https://docs.pwrgit.com)**.

## Get it

### Just want to use it

> **PwrGit is not installed through npm.** The `pwrgit` package on npm only
> reserves the product name and contains no application, launcher, CLI,
> library, SDK, or API. Use the downloads below.

1. **Download PwrGit.**
   - macOS: [PwrGit.dmg](https://github.com/pwrdrvr/PwrGit/releases/latest/download/PwrGit.dmg),
     a Developer ID-signed and Apple-notarized universal build for Apple
     Silicon and Intel Macs.
   - Windows: choose the `windows-x64-setup.exe` asset from the
     [latest GitHub release](https://github.com/pwrdrvr/PwrGit/releases/latest).
2. **Install it.** On macOS, open the DMG and drag PwrGit to Applications
   (macOS 12 or newer). On Windows, run the per-user installer and keep the
   default destination or choose your own.
3. **Optionally connect a forge.** Install and authenticate the GitHub CLI
   (`gh`) or GitLab CLI (`glab`) for hosted repository, fork, PR, and MR
   features. **Settings → Forges** shows what is connected and the exact command
   needed when it is not.

PwrGit includes Git, Git LFS, and Git Credential Manager. A separate system Git
installation is not required for the packaged app.

**Linux packages are not published.** Linux is a build-tested CI target, not a
supported binary download today. The exact platform matrix lives in the
[desktop release runbook](docs/desktop-release-runbook.md).

Updates come from GitHub Releases. PwrGit supports Stable and Beta trains with
Latest and Prerelease tracks, checks on startup and periodically, and also
offers an on-demand check from the app menu and Settings.

### Want to hack on it

PwrGit is a pnpm workspace and uses the Node.js version in `.nvmrc` (Node 24):

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

One install prepares `better-sqlite3` for both Node-based tests and Electron.
The full development workflow, repository boundaries, checks, and pull-request
expectations live in **[CONTRIBUTING.md](CONTRIBUTING.md)** and
**[AGENTS.md](AGENTS.md)**.

## How it's built

| Layer | Stack | Where it lives |
|---|---|---|
| Desktop shell | Electron + TypeScript + React + electron-vite | `apps/desktop/` |
| Git runtime | Dugite with bundled Git, Git LFS, and Git Credential Manager | `apps/desktop/src/main/git/` |
| Forge integrations | GitHub and GitLab providers through `gh` and `glab` | `apps/desktop/src/main/forge/` |
| Local state | SQLite through `better-sqlite3` | `apps/desktop/src/main/persistence/` |
| Shared contracts | Typed commands, events, domain types, and result envelopes | `packages/shared/` |

Main, preload, and renderer are separate bundles. Cross-process work goes
through a typed command bus, and dependency-cruiser enforces the process
boundaries in CI.

## Roadmap

PwrGit currently ships a universal macOS build and a Windows x64 installer.
Linux builds in CI, but Linux packaging and distribution are not live. Follow
the [changelog](CHANGELOG.md) for what has shipped and
[docs.pwrgit.com](https://docs.pwrgit.com) for the operator reference and
current “not yet” lists.

The guarded desktop release pipeline — Apple signing and notarization, Azure
Artifact Signing for Windows, update metadata, and the Linux build-only gate —
is documented in
[docs/desktop-release-runbook.md](docs/desktop-release-runbook.md).

## Going deeper

| Doc | What it covers |
|---|---|
| **[pwrgit.com](https://pwrgit.com)** | Product overview and downloads. |
| **[docs.pwrgit.com](https://docs.pwrgit.com)** | Setup, features, settings, and troubleshooting. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, repository conventions, checks, and pull requests. |
| [AGENTS.md](AGENTS.md) | Load-bearing architecture, native-module, launch, and release guidance. |
| [SECURITY.md](SECURITY.md) | Private vulnerability reporting policy. |
| [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md) | Guarded CI release path, signing environments, assets, and promotion. |
| [docs/third-party-license-notices.md](docs/third-party-license-notices.md) | Generated dependency notices and embedded Git attribution. |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes in each release. |

## License

PwrGit is licensed under the [MIT License](LICENSE). Third-party dependency and
embedded Git notices are aggregated in
[THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) and shipped with desktop releases.

Created by [PwrDrvr LLC](https://pwrdrvr.com). Copyright © 2026 PwrDrvr LLC.
