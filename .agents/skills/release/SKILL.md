---
name: release
description: Prepare, validate, tag, publish, and monitor guarded PwrGit desktop releases, including Winget and Homebrew distribution. Use when the user asks to release PwrGit, prepare a vX.Y.Z or vX.Y.Z-prerelease tag, update CHANGELOG.md or GitHub release notes, verify package/tag/changelog alignment, trigger the desktop release workflow, inspect release or package-manager status, or assess publication readiness.
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
3. [../../../docs/desktop-release-runbook.md](../../../docs/desktop-release-runbook.md)
4. [../../../.github/workflows/release.yml](../../../.github/workflows/release.yml)
5. [../../../scripts/check-desktop-release-metadata.mjs](../../../scripts/check-desktop-release-metadata.mjs)
6. [../../../apps/desktop/scripts/release.mjs](../../../apps/desktop/scripts/release.mjs)
7. [../../../apps/desktop/package.json](../../../apps/desktop/package.json)
8. [../../../apps/desktop/electron-builder.yml](../../../apps/desktop/electron-builder.yml)
9. [../../../apps/desktop/src/main/auto-updater.ts](../../../apps/desktop/src/main/auto-updater.ts)
10. [../../../docs/package-manager-distribution.md](../../../docs/package-manager-distribution.md)
11. [../../../scripts/package-manager-release.mjs](../../../scripts/package-manager-release.mjs)
12. [../../../.github/workflows/package-distribution.yml](../../../.github/workflows/package-distribution.yml)

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
  `apple-signing` Environment. The `windows-signing` Environment has the Azure
  Artifact Signing variables and credentials listed in the current runbook.
  Historical unsigned release mode is not a substitute for a signed installer.
- The auto-updater consumes the same provider and channel metadata that the
  workflow publishes.

If any item is missing, stop the release. Report the exact missing pieces and
ask whether to build the release infrastructure. Do not create a provisional
tag or GitHub Release as a workaround. A local unsigned packaging smoke test is
still allowed when the user explicitly asks for one.

## Branch Lifecycle

Choose `<release-branch>` from the release train, not merely from the
repository's default branch:

- `main` owns the active `N.N` train through its alphas, betas, stable
  `-prerelease.M` candidates, first stable `N.N.0`, and follow-up `N.N.P`
  releases. Promote a beta to stable by preparing and tagging the stable
  metadata on `main`; never create `releases/N.N` only for that promotion.
- Cut `releases/N.N` only after the product owner explicitly decides that
  `main` will begin the next major or minor train. Select the current appropriate
  `main` commit as the branch point; it may intentionally include post-release
  fixes or enhancements rather than being the first stable tag. Then bump
  `main` to the next alpha train.
- After that cut, prepare and tag `N.N.P-prerelease.M` maintenance candidates
  and patches from `releases/N.N`; `main` carries the next train with its
  `-alpha` and `-beta` tags before its own suffix-free stable release. Both
  branches may publish suffix-free stable releases: for example, `v1.0.1` from
  `releases/1.0` and `v2.0.0` from `main`. Do not publish `-alpha` or `-beta`
  from the maintenance branch: the Beta feed is shared and selects the next
  train's higher SemVer candidate. A short-lived `release/v<version>`
  pull-request source branch is only a metadata-review vehicle and never
  substitutes for, or triggers, a maintenance branch; do not create
  `releases/N.N` merely because that source PR promotes a beta to stable.

## Guardrails

- Determine the repository default branch from the remote. Choose the actual
  `<release-branch>` using the lifecycle above: it is `main` while that train is
  active, then `releases/N.N` for maintenance after an owner-directed cut.
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
- A suffix-free stable tag may come from either the active `main` train or a
  maintenance branch. GitHub's `Latest` flag and `/releases/latest` URL name
  one repository-wide release, not one per train. The current updater likewise
  selects a single highest stable release globally; until train pinning exists,
  users who need a maintenance-line update install it manually.
- Keep `-prerelease.N` for Stable candidates. It may be used on `main` while
  the `N.N` train remains there; after the cut, use it for that `N.N` train
  only from `releases/N.N`. Do not reuse `-rc` or `-beta` for 1.0 RCs; `-beta`
  is the Beta Latest identifier.
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
- Require macOS, Windows and both native Linux packaging jobs in `release.yml`
  to succeed before calling the release complete. Verify Linux DEB/RPM/pacman/
  tar.gz assets, per-CPU metadata/checksums and aliases. Existing releases through
  v0.29.0 predate Linux publication; never imply that they contain Linux assets.

## Prepare Release Metadata

1. Before editing versions, compare authoritative remote distribution sources:

   ```bash
   pnpm distribution:audit --output <ignored-directory>/distribution-audit.json
   ```

   Record GitHub Stable Latest, proposed Winget `PwrDrvr.PwrGit` in
   `microsoft/winget-pkgs`, Homebrew `pwrdrvr/tap/pwrgit` (pending registration) in the existing
   `pwrdrvr/homebrew-tap`, current remote versions, ownership and open/closed submission PR
   URLs, architecture-selected URLs/checksums and source/client state. Inspect open and closed prior submissions when registration is missing.
   Do not treat authentication/network/search errors as absence. Reuse existing
   identities and pending submissions, and resolve any central Homebrew cask or
   alternate Winget identity before generating files. A lower maintenance release
   must not downgrade the repository-wide Stable Latest packages. Read the
   distribution runbook for current source and client checks.

2. Determine the release branch, previous tag, and requested next version:

   ```bash
   gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
   git tag --sort=-version:refname | head -n 10
   gh release list --limit 10
   ```

3. Review merged pull requests and direct commits since the previous tag.
   Exclude internal mechanics unless they materially affect installation,
   updates, performance, or data safety.

4. Update the desktop package version without creating a tag:

   ```bash
   pnpm --filter @pwrgit/desktop version <version> --no-git-tag-version
   ```

   If the installed pnpm does not support that command, edit only
   `apps/desktop/package.json` and preserve its formatting.

5. Add the new entry at the top of `CHANGELOG.md`:

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

6. Run the metadata gate and the same pre-signing gates as `release.yml` before
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

If direct push is rejected, use a short-lived `release/v<version>` metadata
source branch and a pull request based on the repository's PR template. Merge
it into the lifecycle-selected `<release-branch>`; it remains a metadata source
branch, not a `releases/N.N` maintenance branch, even when a beta becomes
stable. Wait for every required check and merge using the method documented by
the repository. After landing, fetch the release branch and identify the actual
landed commit; do not tag the pre-merge branch commit by assumption.

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

After success, inspect release metadata. Reuse signature/architecture/checksum
evidence and original Actions artifacts from the publishing run; downloading
Actions artifacts does not fetch GitHub Release assets. Do not download every
release asset merely to list or count it:

```bash
gh release view v<version> --repo pwrdrvr/PwrGit
gh api repos/pwrdrvr/PwrGit/releases/tags/v<version> \
  --jq '.assets[] | {name, size, digest}'
```

Verify the macOS release contains:

- `PwrGit-<version>-universal.dmg`;
- the stable-name `PwrGit.dmg` alias;
- `PwrGit-<version>-universal-mac.zip` and
  `PwrGit-<version>-arm64-mac.zip` and their `.blockmap` files;
- `PwrGit-<version>-arm64.dmg` and its `PwrGit-arm64.dmg` alias; and
- `latest-mac.yml`.

Verify the Windows release contains Authenticode-signed
`PwrGit-<version>-windows-x64-setup.exe`, its blockmap,
`PwrGit-windows-SHA256SUMS`, `latest.yml`, and the stable-name
`PwrGit.Setup.exe` alias.

Do not accept a silently unsigned installer under the signed filename.

If byte-level verification cannot reuse the publishing evidence, download only
the required versioned assets into an ignored directory and verify them. Record
these deliberate validation downloads; they contribute to release download
statistics and must not become periodic monitoring.

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

## Package Manager Updates On Every Release

Follow [../../../docs/package-manager-distribution.md](../../../docs/package-
manager-distribution.md) after verifying GitHub publication. Alpha, beta and
Stable candidates leave both package managers on promoted Stable Latest; record
that decision and compare remote versions again. Run the existing workflow in
read-only mode to verify public reads without downloading or installing
anything:

```bash
gh workflow run package-distribution.yml --repo pwrdrvr/PwrGit --ref <audit-branch> -f audit_only=true
```

Retain its `distribution-audit-standalone` artifact and run URL. Release CI
reuses the same workflow with `audit_only: true` before preparation and after
publication; inspect both stage artifacts. Preflight blocks preparation; a post-
publication blocker needs an owned retry, not republishing. Require complete
search pagination and `incomplete_results=false`; metadata, transport,
throttling and search failures remain named-owner blockers, never package
absence. A completed audit is a source comparison, not client publication. Do
not cut or promote a product release just to register a package manager.

After an explicitly authorized stable promotion, dispatch the distribution
workflow even if a release event already ran it (events emitted by `GITHUB_TOKEN`
may not trigger another workflow):

```bash
gh workflow run package-distribution.yml --repo pwrdrvr/PwrGit --ref main
```

If hosted cross-repository audits hit HTTP 429, inspect the logged token source.
The organization Actions secret `DISTRIBUTION_READ_TOKEN`, shared with PwrGit,
PwrSnap and PwrAgent under selected visibility, selects an expiring public-read
fine-grained PAT with no extra permissions instead of `GITHUB_TOKEN` for those
steps. Do not reuse publishing/admin credentials. Rate limiting is not evidence
of missing repository access, and a PAT does not bypass search or secondary
limits. Use `GH_TOKEN: ${{ secrets.DISTRIBUTION_READ_TOKEN || github.token }}`
for public cross-repository reads; fork checks retain the fallback. Verify
secret metadata and selected repositories, then the read-only Actions log's
source/availability and successful runtime reads, without exposing its value.
`huntharo` / organization maintainers own expiry inventory, renewal/rotation
under the same name and policy, and verification in each selected repository
afterward. Do not infer expiry from secret update time. Follow the distribution
runbook for bounded Retry-After/reset budgets and remaining gates.

The default dispatch audits sources and synchronizes Homebrew without downloading
installers in PwrGit. The tap returns if current; a changed cask verifies both
DMGs using installer caches and downloads on cache misses. Do not repeat asset validation during daily
audits or for unchanged package sources. When generating a Winget submission or
when fresh native evidence is needed, explicitly dispatch once with
`-f validate_assets=true`, or run
`pnpm distribution:prepare v<version> node_modules/.cache/pwrgit-distribution`
locally and reuse its verified cache. Both paths verify cached bytes and download on cache misses, which add download
statistics. The hosted native run reuses exact successful validation records;
`-f validate_assets=true -f force_validation=true` deliberately repeats native
checks while retaining installer caches. Windows reuses the verified installer
and may download a predecessor for upgrade validation.
Retain submission artifacts and validation links rather than rerunning them.

Require immutable versioned URLs and download/hash the actual published bytes
for submission evidence.
Validate arm64 versus universal DMG selection, app bundle ID/version, Developer ID
and Gatekeeper; validate Windows x64 payload, Authenticode on installer and app,
size and SHA-256 against GitHub and `PwrGit-windows-SHA256SUMS`. Never distribute
an unsigned preview or use mutable Latest aliases in manifests. Recheck current
official Winget schema and Homebrew DSL before each submission.

Submit the generated one-version Winget manifest set to `microsoft/winget-pkgs`
under the proposed ID after rechecking identity/history. Microsoft still requires an upstream submission and
review; retain its URL and reuse pending submissions.

Homebrew publication belongs to `pwrdrvr/homebrew-tap`. Its `bump-pwrgit.yml`
validates both Mac architectures and commits the cask to tap `main` automatically.
Initial registration requires merging the setup PR once; subsequent promotions
require no routine bump PR, workflow approval or merge. The product's distribution
workflow dispatches the tap and waits for publication, reporting a direct tap run
link and blocker in its job summary. Verify its `homebrew` job instead of assuming
that generating manifests published the cask.

Immediate cross-repository dispatch uses `HOMEBREW_TAP_DISPATCH_TOKEN`: a
fine-grained PAT for `pwrdrvr/homebrew-tap` only, Actions write permission. The
public-read `DISTRIBUTION_READ_TOKEN` cannot dispatch. The tap commits with its own
`GITHUB_TOKEN`; no cross-repository contents-write token is needed. A 15-minute
schedule reconciles UI promotions and missed dispatches, subject to GitHub's
schedule delays. When promoting through this skill, use the maintainer's existing
CLI authentication to dispatch immediately even if that secret is not configured:

```bash
gh workflow run bump-pwrgit.yml --repo pwrdrvr/homebrew-tap --ref main -f version=<version>
```

Track this run through validation and verify the default-branch cask version.
Do not open another Homebrew update PR as a fallback. If publication fails, report
the failed step/run URL, target and still-published version; fix the cause and
retry the same workflow once. Stop on a repeated failure or missing credential,
retaining the precise next action. Read the distribution runbook for initial
setup, dispatch-token configuration and publication checks.

Require `winget validate`, native silent install/uninstall, user-scope registry
and payload checks, tap style/online audit, Intel and Apple Silicon installs on
disposable clients (never the operator's live app),
and older-to-newer upgrades on subsequent versions. Use `brew upgrade --cask
--greedy` for this auto-updating cask. Record initial-registration upgrade checks
as unavailable when no prior indexed package exists. Use the dedicated lab for
headed launch and retained-settings/repository checks.

After channel publication, rerun `pnpm distribution:audit --check`, refresh Winget's source
and Homebrew's tap, inspect `winget show --id PwrDrvr.PwrGit --exact --source
winget` and `brew info --cask pwrdrvr/tap/pwrgit`, then verify fresh client
install/upgrade. Repository merge does not prove Winget index or Homebrew cache
propagation. Do not call setup live until client discovery and installation are
verified. Track each channel's target, repository and client versions, PR/check
URLs, review/index/cache state, exact blocker, owner and next action. Continue
monitoring pending submissions and address review; report external delays as
pending, not completed publication.

## Local Packaging Fallback

Use local packaging only when CI is unavailable or the user explicitly asks
for it. Follow `.github/workflows/README.md` for platform credentials and never
infer secrets from a sibling repository.

```bash
pnpm --filter @pwrgit/desktop package:dryrun
pnpm --filter @pwrgit/desktop package
```

Publish macOS through `release.yml` only. The direct desktop `release` command
rejects macOS publication because the combined architecture metadata must be
verified before any assets are uploaded.
