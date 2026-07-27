# GitHub Actions

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, PRs | Typecheck, build, unit tests, Linux + Windows desktop E2E. Unit-test jobs rebuild better-sqlite3 for the Node ABI (from `apps/desktop/`) before running vitest. |
| `preview-build.yml` | `build-preview` PR label | Unsigned macOS universal DMG + Windows NSIS installer, uploaded as workflow artifacts. |
| `release.yml` | `v*` tag push (or manual dispatch with a tag) | Tests, stages via `apps/desktop/scripts/release.mjs`, signs + notarizes the macOS universal build, packages/signs the Windows installer, publishes everything to a GitHub Pre-release with notes from `CHANGELOG.md`. |

## PR labels

Keep label names namespaced when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds the unsigned macOS DMG and Windows installer for the PR. Applied label triggers a run; later pushes to a labeled PR re-run it. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.

## Release setup (secrets & variables)

`release.yml` expects two protected GitHub Environments (add required
reviewers + a `v*` tag deployment policy):

- **apple-signing** — `CSC_LINK` (Developer ID .p12, base64),
  `CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64` (App Store Connect .p8, base64),
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- **windows-signing** — `WIN_CSC_LINK` (Authenticode .p12/.pfx, base64),
  `WIN_CSC_KEY_PASSWORD`. Until the cert exists, set the variable
  `WINDOWS_UNSIGNED_RELEASE=true` to publish a `*-unsigned-setup.exe` instead
  (no updater feed is published in that mode).

Optional repo secret `RELEASES_PAT` overrides `github.token` for publishing
release assets.

Cutting a release: bump `apps/desktop/package.json` version, add a matching
`## vX.Y.Z` section to `CHANGELOG.md` (enforced by `pnpm release:check`), then
push the `vX.Y.Z` tag. Releases are born as GitHub Pre-releases; promote to
Latest manually after validation.
