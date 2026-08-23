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

## Prepare and tag

Release from the remote default branch with a clean tracked worktree. The
desktop version in `apps/desktop/package.json`, the `vX.Y.Z` tag, and a
matching `CHANGELOG.md` heading must agree.

```bash
git fetch origin main --tags
RELEASE_TAG=vX.Y.Z pnpm release:check
pnpm lint
pnpm test
pnpm build
```

Commit the version and changelog together, land that commit on `main`, rerun
the metadata check on the landed commit, and create a signed annotated tag.
Pushing the tag starts the workflow. A manual dispatch is allowed only for a
tag that already exists in the repository.

Every workflow-created release starts as a GitHub Pre-release. Promotion to
Latest is a separate maintainer action after verification; only suffix-free
stable tags may be promoted.

## CI flow

1. The macOS prepare job checks metadata, typechecks, tests, checks license
   notices, builds, and creates a deploy stage.
2. `apple-signing` signs, notarizes, and packages the universal app, then
   stages the DMG, updater ZIP, blockmap, and `latest-mac.yml`.
3. Linux validates that the desktop source builds. It produces no package.
4. Windows prepares a self-contained x64 stage without credentials.
5. `windows-signing` uses Azure Artifact Signing during NSIS packaging and
   verifies Authenticode on both the app executable and installer.
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
- `PwrGit-<version>-universal-mac.zip`, its blockmap, and `latest-mac.yml`;
- `PwrGit-<version>-windows-x64-setup.exe`, its blockmap, `latest.yml`, and
  `PwrGit-windows-SHA256SUMS`; and
- no Linux installer or package.

```bash
gh run list --workflow release.yml --limit 10
gh release view vX.Y.Z --repo pwrdrvr/PwrGit
```

Smoke-test installation and launch on macOS and Windows before promotion. Then:

```bash
gh release edit vX.Y.Z --repo pwrdrvr/PwrGit --latest --prerelease=false
```

Do not create a partial release by hand while a signing approval or platform
job is still pending.

## Local packaging

Use local packaging only for a smoke test or when CI is unavailable:

```bash
pnpm --filter @pwrgit/desktop package:dryrun
```

That command makes a locally ad-hoc-signed macOS package, not a Developer
ID-signed release, and does not publish it. Release publication remains a
guarded CI operation.
