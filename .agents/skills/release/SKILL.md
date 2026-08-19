---
name: release
description: Prepare, validate, tag, publish, and monitor guarded PwrGit desktop releases. Use when the user asks to release PwrGit, prepare a vX.Y.Z or vX.Y.Z-prerelease tag, update CHANGELOG.md or GitHub release notes, verify package/tag/changelog alignment, trigger the macOS universal and Windows desktop release workflow, inspect release status, or assess whether the repository is ready to publish.
---

# Release

Use this skill for PwrGit desktop releases. Treat releases as a guarded,
two-stage operation: preparing release metadata does not authorize publishing a
tag, and publishing a tag does not make a release complete until CI and the
GitHub Release are verified.

## Read First

Read the current versions of these files before changing release metadata:

1. [../../../AGENTS.md](../../../AGENTS.md)
2. [../../../.github/workflows/README.md](../../../.github/workflows/README.md)
3. [../../../.github/workflows/release.yml](../../../.github/workflows/release.yml)
4. [../../../scripts/check-desktop-release-metadata.mjs](../../../scripts/check-desktop-release-metadata.mjs)
5. [../../../apps/desktop/scripts/release.mjs](../../../apps/desktop/scripts/release.mjs)
6. [../../../apps/desktop/package.json](../../../apps/desktop/package.json)
7. [../../../apps/desktop/electron-builder.yml](../../../apps/desktop/electron-builder.yml)
8. [../../../apps/desktop/src/main/auto-updater.ts](../../../apps/desktop/src/main/auto-updater.ts)

If any file does not exist, handle that through the readiness gate below instead
of assuming the sibling repositories' configuration applies.

## Release Readiness Gate

Before editing versions, creating tags, or publishing anything, verify all of
the following:

- `CHANGELOG.md` exists and has an established release-entry format.
- `.github/workflows/README.md` documents the current targets, signing
  environments, temporary unsigned-Windows mode, and promotion to Latest.
- `.github/workflows/release.yml` validates metadata before accessing secrets,
  builds the macOS universal and Windows targets, and publishes from a pushed
  tag or an explicitly documented manual dispatch.
- `scripts/check-desktop-release-metadata.mjs` exists and the root
  `package.json` exposes it as `pnpm release:check`.
- `apps/desktop/electron-builder.yml` publishes to `pwrdrvr/PwrGit` with
  `releaseType: prerelease`; `publish: null` is not release-ready.
- The protected `apple-signing` and `windows-signing` GitHub Environments exist,
  require reviewers, and allow only `v*` release tags.
- All Apple secrets listed in `.github/workflows/README.md` exist in the
  `apple-signing` Environment. The `windows-signing` Environment either has the
  two Authenticode secrets or explicitly sets
  `WINDOWS_UNSIGNED_RELEASE=true`.
- The auto-updater consumes the same provider and channel metadata that the
  workflow publishes.

If any item is missing, stop the release. Report the exact missing pieces and
ask whether to build the release infrastructure. Do not create a provisional
tag or GitHub Release as a workaround. A local unsigned packaging smoke test is
still allowed when the user explicitly asks for one.

## Guardrails

- Determine the repository default branch from the remote. Release from it
  unless the user explicitly approves another ref.
- Start from a clean tracked working tree. Preserve untracked or unrelated user
  work. If tracked files are dirty, stop and ask before changing release
  metadata.
- Fetch the release branch and tags before planning:

  ```bash
  git fetch origin <release-branch> --tags
  ```

- Treat `apps/desktop/package.json` as the desktop release version source. The
  root workspace version is not a substitute.
- Use a leading-`v` tag such as `v0.0.1-alpha.1`.
- Require the tag version, desktop package version, and `CHANGELOG.md` heading
  to match exactly.
- Settings → Updates exposes two axes: **channel** (Stable or Beta) and
  **track** (Latest or Prerelease). Encode those slots in the tag suffix so
  GitHub `/releases/latest` stays on the Stable Latest train:
  - Stable Latest: `v1.0.5` (no suffix; GitHub Latest)
  - Stable Prerelease: `v1.0.6-prerelease.1` (GitHub Pre-release)
  - Beta Latest: `v1.1.0-beta.3` (GitHub Pre-release; smoke-checked `main`)
  - Beta Prerelease: `v1.1.0-alpha.7` (GitHub Pre-release; may not install)
- Keep `-prerelease.N` for Stable RCs. Do not reuse `-rc` or `-beta` for 1.0
  RCs; `-beta` is the Beta Latest identifier.
- `main` tags with a prerelease suffix must stay GitHub Pre-release so they
  never steal `/releases/latest` from the Stable train.
- To promote a smoked alpha to beta, bump `apps/desktop/package.json` and add
  a CHANGELOG heading from `X.Y.Z-alpha.N` to `X.Y.Z-beta.M`, commit, and tag
  that commit. Do not add a second tag to the alpha SHA: the metadata gate and
  the baked app version both come from `package.json`.
- Create every CI-published version as a GitHub Pre-release, including a stable
  SemVer such as `v1.0.0`. Promotion to Latest is a separate, explicit operator
  action after validation.
- Keep the MIT license and all first-party `"license": "MIT"` declarations
  intact.
- Do not create a GitHub Release by hand before the build succeeds when the
  workflow delegates creation to electron-builder.
- Do not use GitHub-generated notes as the final release notes.
- Do not force-push the default branch or rewrite an existing release tag
  without explicit user approval.
- Sign release metadata commits. Do not silently fall back from a failed signed
  tag to an unsigned tag.
- Treat an environment approval gate as an intermediate state, not release
  completion. Continue through artifact publishing and release-note
  verification after approval.
- Require both operating-system targets in `release.yml` to succeed before
  calling the release complete. Linux packaging is configured in
  `electron-builder.yml` but is not currently published by the release
  workflow; do not imply that a Linux artifact is part of the release.

## Prepare Release Metadata

1. Determine the release branch, previous tag, and requested next version:

   ```bash
   gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
   git tag --sort=-version:refname | head -n 10
   gh release list --limit 10
   ```

2. Review merged pull requests and direct commits since the previous tag.
   Exclude internal mechanics unless they materially affect installation,
   updates, performance, or data safety.

3. Update the desktop package version without creating a tag:

   ```bash
   pnpm --filter @pwrgit/desktop version <version> --no-git-tag-version
   ```

   If the installed pnpm does not support that command, edit only
   `apps/desktop/package.json` and preserve its formatting.

4. Add the new entry at the top of `CHANGELOG.md`:

   ```md
   ## v0.0.1-alpha.1 - YYYY-MM-DD
   ```

   Write for PwrGit users, not as a list of commit subjects. Use:

   ```md
   - <Feature Area> - <Added|Improved|Fixed> <user-visible behavior and why it matters>.
   ```

   Examples:

   ```md
   - Worktrees - Improved stale-worktree signals so safe cleanup candidates are easier to identify.
   - Sync - Fixed rejected pushes so the app explains the non-fast-forward state without losing context.
   - Commit Graph - Added clearer branch and pull-request markers across large repositories.
   - Minor - Dependency updates and small interface polish.
   ```

5. Run the metadata gate and the same pre-signing gates as `release.yml` before
   committing:

   ```bash
   RELEASE_TAG=v<version> pnpm release:check
   pnpm typecheck
   pnpm test
   pnpm build
   ```

   Run `pnpm --filter @pwrgit/desktop package:dryrun` when a local macOS
   packaging smoke is appropriate. No native rebuild belongs in that sequence:
   one `pnpm i` leaves `better-sqlite3` built for both ABIs, so tests and
   packaging share an install. If a native ABI error does surface,
   `pnpm --filter @pwrgit/desktop run rebuild:electron-native` repairs
   whichever half is stale (see the root `AGENTS.md`).

## Commit And Land

Commit the version and changelog together as a signed checkpoint:

```bash
git add apps/desktop/package.json CHANGELOG.md
git commit -S -m "chore(release): prepare v<version>"
git log -1 --show-signature --format=fuller
```

If maintainer direct-push bypass is explicitly supported, push the signed
commit to the release branch, then fetch and fast-forward before tagging:

```bash
git push origin HEAD:<release-branch>
git fetch origin <release-branch> --tags
git pull --ff-only
```

If direct push is rejected, use a short-lived `release/v<version>` branch and a
pull request based on the repository's PR template. Wait for every required
check and merge using the method documented by the repository. After landing,
fetch the release branch and identify the actual landed commit; do not tag the
pre-merge branch commit by assumption.

Rerun the metadata gate on the landed release-branch commit:

```bash
RELEASE_TAG=v<version> pnpm release:check
```

## Tag And Publish

Only proceed when the user has asked to publish, not merely prepare.

Create exactly one tag on the landed release-branch commit. Prefer a signed
annotated tag:

```bash
git tag -s v<version> -m "v<version>"
git tag -v v<version>
git merge-base --is-ancestor v<version> origin/<release-branch>
```

If tag signing fails, stop and ask before creating an unsigned tag. Verify that
the tag does not already exist locally or remotely before pushing it.

Push the tag only after metadata is present on the release branch:

```bash
git push origin v<version>
```

For manual dispatch, verify that the tag already exists on GitHub:

```bash
git ls-remote --tags origin v<version>
gh workflow run release.yml --ref <release-branch> -f tag=v<version>
```

## Monitor And Verify

Locate and watch the workflow run:

```bash
gh run list --workflow release.yml --limit 10
gh run watch <run-id>
```

If the run takes time to appear, wait 5-10 minutes before concluding it did not
start. For a long release, use the available monitoring mechanism and preserve
the run ID so monitoring continues after any approval gate.

Before approving either signing environment, verify:

- the run is for the intended tag;
- the tag points at the intended release-branch commit;
- the package version and changelog match the tag; and
- the pre-signing metadata and build jobs succeeded.

On failure, inspect the failed logs:

```bash
gh run view <run-id> --log-failed
```

After success, inspect the release and download its assets into an ignored
temporary directory:

```bash
gh release view v<version> --repo pwrdrvr/PwrGit
gh release download v<version> \
  --repo pwrdrvr/PwrGit \
  --dir <ignored-release-directory>
```

Verify the macOS release contains:

- `PwrGit-<version>-universal.dmg`;
- the stable-name `PwrGit.dmg` alias;
- the universal updater ZIP and `.blockmap`; and
- `latest-mac.yml`.

Verify the Windows release contains one of these intentional shapes:

- Authenticode-signed `PwrGit-<version>-windows-x64-setup.exe`, its blockmap,
  `SHA256SUMS`, and `latest.yml`; or
- `PwrGit-<version>-windows-x64-unsigned-setup.exe` while
  `WINDOWS_UNSIGNED_RELEASE=true`, with no updater feed.

Do not accept a silently unsigned installer under the signed filename.

Verify the final release body is non-empty and matches the approved changelog
entry:

```bash
gh release view v<version> \
  --repo pwrdrvr/PwrGit \
  --json name,body,isPrerelease \
  --jq '{name, isPrerelease, bodyLength: (.body | length)}'
```

Require `bodyLength` to be greater than zero and `isPrerelease` to be `true`.

If the workflow's notes step fails, use the metadata checker to extract the
exact changelog entry, inspect it, then apply it:

```bash
pnpm release:check \
  --tag v<version> \
  --notes-file <ignored-release-directory>/RELEASE_NOTES.md
gh release edit v<version> \
  --repo pwrdrvr/PwrGit \
  --notes-file <ignored-release-directory>/RELEASE_NOTES.md
```

Do not compose replacement notes ad hoc after approval.

## Local Packaging Fallback

Use local packaging only when CI is unavailable or the user explicitly asks
for it. Follow `.github/workflows/README.md` for platform credentials and never
infer secrets from a sibling repository.

```bash
pnpm --filter @pwrgit/desktop package:dryrun
pnpm --filter @pwrgit/desktop package
```

Run `pnpm --filter @pwrgit/desktop release` only after the publish provider is
configured and the user has explicitly authorized publishing.
