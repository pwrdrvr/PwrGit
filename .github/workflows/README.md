# GitHub Actions

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, PRs | Typecheck, build, unit tests, Linux + Windows desktop E2E. Unit-test jobs rebuild better-sqlite3 for the Node ABI (from `apps/desktop/`) before running vitest. |
| `preview-build.yml` | `build-preview` PR label | Unsigned macOS universal DMG + Windows NSIS installer, uploaded as workflow artifacts. |
| `release.yml` | `v*` tag push, manual dispatch with a tag, or `ci:windows-signing` PR label | Tests and stages via `apps/desktop/scripts/release.mjs`. Tagged runs gate GitHub Pre-release creation on Linux build, signed/notarized macOS, and Azure-signed Windows. Labeled same-repo PRs run the real Windows prepare/sign/Authenticode path and upload workflow artifacts only. |

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

Settings → Updates maps tag suffixes onto two axes (Stable|Beta ×
Latest|Prerelease):

| Settings slot | Tag | GitHub flag |
|---|---|---|
| Stable · Latest | `v1.0.5` | Latest |
| Stable · Prerelease | `v1.0.6-prerelease.1` | Pre-release |
| Beta · Latest | `v1.1.0-beta.3` | Pre-release |
| Beta · Prerelease | `v1.1.0-alpha.7` | Pre-release |

Use `-prerelease.N` for Stable RCs. Use `-alpha.N` / `-beta.N` on `main`.
Every `main` tag with a prerelease suffix must stay a GitHub Pre-release so it
cannot steal `/releases/latest` from the Stable train. The updater pins
electron-updater to the selected tag via the generic GitHub download feed.
