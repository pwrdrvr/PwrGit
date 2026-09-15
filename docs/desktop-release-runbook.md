# Desktop Release Runbook

PwrGit publishes desktop releases through
[`.github/workflows/release.yml`](../.github/workflows/release.yml). The guarded
CI path is the canonical release path.

## Published targets

| Platform | Release output | Update behavior |
|---|---|---|
| macOS | Signed and notarized universal DMG and updater ZIP | In-app updates from GitHub Releases |
| Windows | Azure-signed x64 NSIS installer | In-app updates from GitHub Releases |
| Linux | Build validation only | No package or release asset is published |

`electron-builder.yml` contains future Linux DEB packaging configuration, but
the release workflow only runs `pnpm build` on Linux. Do not advertise a Linux
binary until the workflow publishes and verifies one.

## Protected environments

The repository has two reviewed GitHub Environments, each restricted to `v*`
tags:

- `apple-signing` secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- `windows-signing` variables: `WIN_AZURE_SIGN_PUBLISHER_NAME`,
  `WIN_AZURE_SIGN_ENDPOINT`, `WIN_AZURE_SIGN_ACCOUNT`, and
  `WIN_AZURE_SIGN_PROFILE`; secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
  `AZURE_CLIENT_SECRET`.

Optional repository secret `RELEASES_PAT` replaces the workflow token when
publishing assets. Never place signing material in the repository or a
workflow artifact.

The macOS and Windows prepare jobs run without signing credentials. Each
protected job verifies a SHA-256 archive prepared by the unprivileged job and
does not check out source or install dependencies after credentials become
available.

## Branch lifecycle

`main` owns the active `N.N` train through alpha, beta, first stable, and
follow-up `N.N.P` releases. Promoting a beta to stable is a metadata commit and
tag on `main`, not a reason to create `releases/N.N`.

Cut `releases/N.N` only after the product owner explicitly decides to begin the
next major or minor train on `main`. Choose the current appropriate `main`
commit as the maintenance branch point; it may intentionally contain
post-release fixes or enhancements rather than match the first stable tag. Then
bump `main` to the next alpha train. After the cut, prepare `N.N` maintenance
candidates and patches from `releases/N.N`, while `main` carries the next train.

Use `N.N.P-prerelease.M` for Stable maintenance candidates after the cut. A
Stable `-prerelease.M` candidate is also valid on `main` while its `N.N` train
is still active there. Once that train moves to `releases/N.N`, only that branch
may publish its `N.N.P-prerelease.M` candidates; the next `main` train uses
`-alpha` and `-beta`. Those suffixes share one Beta feed, where a higher-SemVer
next-train candidate would otherwise hide the maintenance candidate.

## Prepare and tag

Choose `<release-branch>` from the lifecycle above: `main` while its `N.N`
train is active, or `releases/N.N` for that train after an owner-directed cut.
Release from that branch with a clean tracked worktree. The desktop version in
`apps/desktop/package.json`, the `vX.Y.Z` tag, and a matching `CHANGELOG.md`
heading must agree.

```bash
git fetch origin <release-branch> --tags
RELEASE_TAG=vX.Y.Z pnpm release:check
pnpm lint
pnpm test
pnpm build
```

Commit the version and changelog together, land that commit on
`<release-branch>`, rerun the metadata check on the landed commit, and create a
signed annotated tag. Pushing the tag starts the workflow. A manual dispatch is
allowed only for a tag that already exists in the repository.

Every workflow-created release starts as a GitHub Pre-release. Promotion to
Latest is a separate maintainer action after verification; only suffix-free
stable tags may be promoted.

## CI flow

1. The macOS prepare job checks metadata, typechecks, selects an Xcode with
   actool 26 for the icon compile (`.github/actions/select-xcode-for-actool`),
   tests, checks license notices, builds, and creates a deploy stage.
2. `apple-signing` signs, notarizes, and packages the universal and arm64 apps, then
   stages both DMGs, updater ZIPs, blockmaps, and one `latest-mac.yml`.
3. Linux validates that the desktop source builds. It produces no package.
4. Windows prepares a self-contained x64 stage without credentials.
5. `windows-signing` uses Azure Artifact Signing during NSIS packaging and
   verifies Authenticode on both the app executable and installer, then copies
   the verified installer to the stable `PwrGit.Setup.exe` alias.
6. The publication job waits for macOS, Windows, and the Linux build gate,
   then creates one release with changelog-derived notes and all published
   assets.

For an opt-in Windows signing smoke test on a same-repository PR, apply the
`ci:windows-signing` label. That path uploads a short-lived workflow artifact
and never creates a GitHub Release.

## Verify before promotion

The release workflow must finish successfully, including the publication job.
Then confirm that the release body is non-empty and that the assets include:

- `PwrGit-<version>-universal.dmg` and the stable `PwrGit.dmg` alias;
- `PwrGit-<version>-arm64.dmg` and the stable `PwrGit-arm64.dmg` alias;
- `PwrGit-<version>-universal-mac.zip` and `PwrGit-<version>-arm64-mac.zip`,
  their blockmaps, and `latest-mac.yml` listing both ZIPs with universal in the
  legacy top-level `path`/`sha512`;
- `PwrGit-<version>-windows-x64-setup.exe`, its blockmap, `latest.yml`, and
  `PwrGit-windows-SHA256SUMS`;
- the stable `PwrGit.Setup.exe` alias, a byte-for-byte copy of that installer.
  It is deliberately absent from `PwrGit-windows-SHA256SUMS` — the same bytes
  under a second name state no new fact, and one build listed twice reads like
  two builds. Check it against the versioned installer's recorded digest:

  ```bash
  shasum -a 256 PwrGit.Setup.exe
  grep -- -setup.exe PwrGit-windows-SHA256SUMS
  ```

- no Linux installer or package.

```bash
gh run list --workflow release.yml --limit 10
gh release view vX.Y.Z --repo pwrdrvr/PwrGit
```

Smoke-test installation and launch on macOS and Windows before promotion. Then:

```bash
gh release edit vX.Y.Z --repo pwrdrvr/PwrGit --latest --prerelease=false
```

`releases/latest/download/` resolves only for the release marked Latest, so the
stable aliases start working at this step and not before. After promoting the
first release that carries `PwrGit.Setup.exe`, point README.md's Windows
download chip at
`https://github.com/pwrdrvr/PwrGit/releases/latest/download/PwrGit.Setup.exe`
and drop the sentence sending readers to pick the asset out of the releases
page. Confirm the URL downloads the installer first: a chip that 404s is worse
than one that opens the releases page.

Do not create a partial release by hand while a signing approval or platform
job is still pending.

## Local packaging

Use local packaging only for a smoke test or when CI is unavailable:

```bash
pnpm --filter @pwrgit/desktop package:dryrun
```

Packaging the mac app needs an Xcode 26 or newer selected (`xcode-select -p`,
or export `DEVELOPER_DIR`): electron-builder compiles `build/icon.icon` with
`actool` and refuses older versions — see `apps/desktop/AGENTS.md` "macOS app
icon".

That command makes a locally ad-hoc-signed macOS package, not a Developer
ID-signed release, and does not publish it. Release publication remains a
guarded CI operation.

For non-dry-run macOS signing, `release.mjs` decodes a base64 `CSC_LINK` when
needed and imports the supplied Developer ID certificate into a temporary keychain
even when other signing identities are already installed. An empty or unset
`CSC_KEY_PASSWORD` is supported for passwordless certificates. The temporary
keychain uses its own generated password. It makes that keychain first in the user search
list, sets `CSC_NAME`, and removes `CSC_LINK` and `CSC_KEY_PASSWORD` before
starting electron-builder. This avoids electron-builder 26.15.x applying the
`.p12` password to its generated keychain on macOS 26. The script restores the
previous keychain list and deletes the temporary keychain when packaging exits,
including when certificate import or subsequent keychain setup fails.
`package:dryrun` does not import a certificate or alter keychains.

## Architecture upgrade verification

Both apps retain the same bundle identity, signing identity and user-data
location. An existing universal app updates to arm64 on Apple Silicon,
including when running under Rosetta; Intel continues to receive universal.
A same-version installation needs a manual DMG replacement to change its
architecture. Choosing the universal DMG on Apple Silicon does not pin future
updates to universal. A later universal-only release remains a valid fallback.

Before promotion, smoke-test a signed older-to-newer update on Intel, native
Apple Silicon and Rosetta. Verify launch, SQLite, embedded Git and retained
settings. Test both full downloads and fallback when a previous arm64 blockmap
is absent. Local dry-run builds validate packaging and architecture selection,
but do not prove Developer ID signing, notarization or Squirrel replacement.

Publish macOS only through `release.yml`; the direct macOS release command
fails before building. The workflow waits until both apps and the combined
metadata have been verified before its existing all-platform publication gate.
