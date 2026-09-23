# GitHub Actions

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, PRs | Typecheck, build, unit tests, Linux + macOS + Windows desktop E2E. Unit-test jobs run `rebuild:electron-native` first — a no-op after a fresh install, which repairs a restored `node_modules` cache whose better-sqlite3 build predates the two-ABI layout. Documentation-only PRs skip those jobs after Classify Changes (see below). |
| `preview-build.yml` | `build-preview` PR label | Unsigned macOS universal + arm64 DMGs and updater ZIPs (macOS 26/Xcode 26) + Windows NSIS installer, uploaded as workflow artifacts. |
| `release.yml` | `v*` tag push, manual dispatch with a tag, or `ci:windows-signing` PR label | Tests and stages via `apps/desktop/scripts/release.mjs`. Tagged runs gate GitHub Pre-release creation on Linux build, signed/notarized macOS (macOS 26/Xcode 26), and Azure-signed Windows. Labeled same-repo PRs run the real Windows prepare/sign/Authenticode path and upload workflow artifacts only. |

## macOS desktop E2E

Four shards run on the same self-hosted ARM64 Tart pool as PwrAgnt, selected
by `[self-hosted, macOS, ARM64, pwrdrvr-macos]`. Add `pwrdrvr/PwrGit` to that
organization runner group's selected repositories before enabling the jobs;
otherwise they remain queued. Guests need a logged-in desktop session.
The hosted `macos-26` install job primes the matching macOS/ARM64 cache.

Mac jobs run on main pushes and code-impacting same-repository PRs. Fork PRs
skip both Mac jobs so untrusted fork code never reaches the persistent guests.
The required `Desktop E2E` check is the `desktop-e2e-result` aggregate, not
any one platform job. It requires all Linux shards, all Windows shards, and —
for eligible runs — all Mac shards. A fork PR is the one exception: the Mac
lane is not scheduled there, so the aggregate records a warning that macOS
coverage is unverified and passes on the other two. Every other missing result,
a `skipped` from a broken install job included, fails the check.

Adding a platform to the gate is a change to that job's `needs`, not to branch
protection: the ruleset names only `Desktop E2E`, so the context stays valid.
Do not add per-shard job names as required checks — they bind the ruleset to
the matrix size, and a skipped job satisfies a required check, so a fork-guarded
lane would gate nothing.

Each shard uses one Playwright worker and uploads its own artifacts. The Mac
lane uses software rendering to avoid Tart virtual GPU resets and clears
workspace-scoped orphaned Electron processes plus dev Electron saved window
state before testing, following PwrAgnt's persistent-runner cleanup.

## macOS Icon Composer runner

The macOS release and preview packaging jobs use `macos-26`. Although the
`macos-15` image contains Xcode 26, its host frameworks are too old for
Xcode 26's `AssetCatalogAgent`; Icon Composer compilation fails after Xcode
selection with missing CoreMedia/MediaToolbox symbols. The shared
`select-xcode-for-actool` action requires both a macOS 26 host and actool 26+
so release validation remains mandatory and fails early if a workflow is moved
to an incompatible runner.

## Documentation-only PRs

`ci.yml` classifies each pull request before the expensive jobs. If every
changed path (and `previous_filename` on a rename) is under `docs/` or ends
with `.md` (case-insensitive), Classify Changes sets `code_impacting=false`
and these jobs skip: `install-deps`, `windows-install-deps`, `typecheck`,
`macos-install-deps`, `macos-e2e`, `build`, `test`, `desktop-e2e`,
`desktop-e2e-result`, `windows`,
`windows-e2e`. Push/main events, API errors, and incomplete file lists still
run full CI.

Do not add `paths` or `paths-ignore` to the `pull_request` trigger. Required
status checks (`Typecheck`, `Desktop E2E`) must still exist on every PR;
skipped jobs satisfy those checks, missing jobs leave them pending.

## PR labels

Keep label names namespaced when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds the unsigned macOS DMG and Windows installer for the PR. Applied label triggers a run; later pushes to a labeled PR re-run it. |
| `ci:windows-signing` | `release.yml` | For same-repo PRs, runs the release Windows prepare/build/Azure-sign/Authenticode-verification path and uploads the signed installer to the workflow run. It never creates a GitHub Release. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.

## Release setup (secrets & variables)

`release.yml` expects two protected GitHub Environments (add required
reviewers + a `v*` tag deployment policy):

- **apple-signing** — `CSC_LINK` (Developer ID .p12, base64),
  `CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64` (App Store Connect .p8, base64),
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- **windows-signing** — environment variables
  `WIN_AZURE_SIGN_PUBLISHER_NAME`, `WIN_AZURE_SIGN_ENDPOINT`,
  `WIN_AZURE_SIGN_ACCOUNT`, `WIN_AZURE_SIGN_PROFILE`; environment secrets
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. The protected
  job passes `--require-signing`, so missing or partial configuration fails
  instead of producing an unsigned release.

The credentialed Windows job receives a verified, self-contained stage and
does not check out the repository or install project dependencies. For PR
events, GitHub evaluates environment deployment branch rules against the merge
ref (`refs/pull/<number>/merge`), not the PR head branch. Add only the exact
merge ref being validated; if it is not allowed, GitHub blocks the deployment
before the credentialed job starts. Do not switch this workflow to
`pull_request_target`.

Optional repo secret `RELEASES_PAT` overrides `github.token` for publishing
release assets.

Cutting a release: bump `apps/desktop/package.json` version, add a matching
`## vX.Y.Z` section to `CHANGELOG.md` (enforced by `pnpm release:check`), then
push the `vX.Y.Z` tag. No release is created until Linux, macOS, and Windows
jobs succeed. Releases are born as GitHub Pre-releases; promote to Latest
manually after validation.

Publication first creates a draft with changelog notes. It uploads the signed
assets one at a time and compares each GitHub asset's SHA-256 digest and size
with the downloaded workflow artifact. A lost upload response can report a 422
after GitHub accepted the bytes; the publication job reconciles that asset and
continues. A rerun resumes a matching draft, and only a complete 14-asset
inventory becomes a visible Pre-release. A conflicting asset or partial
published release fails without replacing assets. Recovery from a failed run
can use its signed workflow artifacts with the updated publisher, while they
remain available; see the runbook.

`main` owns the active `N.N` train through alpha, beta, first stable, and
follow-up `N.N.P` releases. Do not create `releases/N.N` merely to promote a
beta to stable. Cut that maintenance branch only after the product owner
explicitly decides to begin the next major or minor train on `main`; choose the
current appropriate `main` commit as the branch point, even when it includes
post-release fixes or enhancements, then bump `main` to the next alpha train.
After the cut, release `N.N.P-prerelease.M` maintenance candidates and patches
from `releases/N.N` and keep the next train on `main` with its `-alpha` and
`-beta` tags before its own suffix-free stable release. Both branches may
publish suffix-free stable releases: for example, `v1.0.1` from `releases/1.0`
and `v2.0.0` from `main`.

Settings → Updates maps tag suffixes onto two axes (Stable|Beta ×
Latest|Prerelease):

| Settings slot | Tag | GitHub flag |
|---|---|---|
| Stable · Latest | `v1.0.5` | Latest |
| Stable · Prerelease | `v1.0.6-prerelease.1` | Pre-release |
| Beta · Latest | `v1.1.0-beta.3` | Pre-release |
| Beta · Prerelease | `v1.1.0-alpha.7` | Pre-release |

A suffix-free stable tag may come from either the active `main` train or a
maintenance branch. GitHub's `Latest` flag and `/releases/latest` URL name one
repository-wide release, not one per train. The current updater likewise
selects a single highest stable release globally; until train pinning exists,
users who need a maintenance-line update install it manually.

Use `-prerelease.N` for Stable candidates. It may be tagged on `main` while the
current `N.N` train is active there; after the cut, use it for that train only
on `releases/N.N`. Reserve `-alpha.N` / `-beta.N` for the active `main` train:
the Beta feed is shared and its higher SemVer next-train candidate would hide a
maintenance `-alpha` or `-beta`. Every prerelease tag must stay a GitHub
Pre-release so it cannot steal `/releases/latest` from the Stable train. The
updater pins electron-updater to the selected tag via the generic GitHub
download feed.

## macOS architectures

Release and preview packaging build universal and arm64 apps sequentially from
one deploy stage. `PwrGit.dmg` remains universal; `PwrGit-arm64.dmg` is the
Apple Silicon alias. Both versioned DMGs, ZIPs and ZIP blockmaps ship together.
`release.mjs` validates both apps before writing `latest-mac.yml` with both
ZIP descriptors and a universal legacy fallback. The pinned updater chooses
arm64 on Apple Silicon (including Rosetta) and universal on Intel.

Use the guarded release workflow to publish macOS. Direct macOS publication
through `pnpm release` is rejected so electron-builder cannot publish an
unvalidated intermediate manifest. `package` and `package:dryrun` still build
both architectures locally without publication.

## Windows installer name

The release publishes two installer assets that are the same bytes:
`PwrGit-<version>-windows-x64-setup.exe`, which `latest.yml` names and
electron-updater downloads, and `PwrGit.Setup.exe`, a stable alias so
`releases/latest/download/PwrGit.Setup.exe` keeps working across versions. The
versioned asset is never renamed away.

`windows-sign` cuts the alias with
`apps/desktop/scripts/windows-release-artifacts.mjs`, after the Authenticode
verification step and never before it: the alias is a byte-for-byte copy and
would otherwise inherit an unsigned intermediate. The script checks each
installer against its `SHA256SUMS` entry before copying and the copy against the
original after, and refuses an architecture it has no agreed alias for rather
than pointing a stable URL at the wrong installer. The aliases stay out of
`SHA256SUMS`; the runbook says why.

The name has no space on purpose. GitHub Releases replaces spaces in an
uploaded asset's filename with periods — on `gh`, the REST API and the web UI
alike — and a later rename cannot restore one, so `PwrGit Setup.exe` would
publish as `PwrGit.Setup.exe` regardless. Naming the build output that way
keeps it spelled the same as the published asset. A future Windows ARM build
takes `PwrGit.Setup.Arm.exe`. This does not match the macOS aliases
(`PwrGit.dmg`, `PwrGit-arm64.dmg`), which are already published URLs that must
keep working; each platform keeps its own spelling deliberately.
