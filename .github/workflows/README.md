# GitHub Actions

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, PRs | Typecheck, build, unit tests, Linux + Windows desktop E2E. Unit-test jobs run `rebuild:electron-native` first — a no-op after a fresh install, which repairs a restored `node_modules` cache whose better-sqlite3 build predates the two-ABI layout. |
| `preview-build.yml` | `build-preview` PR label | Unsigned macOS universal DMG + Windows NSIS installer, uploaded as workflow artifacts. |
| `release.yml` | `v*` tag push, manual dispatch with a tag, or `ci:windows-signing` PR label | Tests and stages via `apps/desktop/scripts/release.mjs`. Tagged runs gate GitHub Pre-release creation on Linux build, signed/notarized macOS, and Azure-signed Windows. Labeled same-repo PRs run the real Windows prepare/sign/Authenticode path and upload workflow artifacts only. |
| `dependabot-licenses.yml` | Dependabot PRs touching a manifest or the lockfile, manual dispatch with a PR number | Runs the license allowlist gate, then regenerates and pushes `THIRD_PARTY_LICENSES` so the PR's `Typecheck` check can pass. Needs a token to be provisioned before the push re-triggers CI — see below. |

## PR labels

Keep label names namespaced when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `build-preview` | `preview-build.yml` | Builds the unsigned macOS DMG and Windows installer for the PR. Applied label triggers a run; later pushes to a labeled PR re-run it. |
| `ci:windows-signing` | `release.yml` | For same-repo PRs, runs the release Windows prepare/build/Azure-sign/Authenticode-verification path and uploads the signed installer to the workflow run. It never creates a GitHub Release. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.

## Dependabot license regeneration (setup required)

`pnpm licenses:check` hashes the dependency tree, so **any** dependency change
makes the committed `THIRD_PARTY_LICENSES` stale — and Dependabot cannot run
`pnpm licenses:generate` itself. Every Dependabot PR therefore lands with
`Typecheck` and `Windows (typecheck + build + test)` red on that one line, and
`Typecheck` is a required check, so the PR cannot merge until someone pushes the
regenerated notice by hand. `dependabot-licenses.yml` pushes that commit.

**It runs the allowlist gate first and pushes nothing if that fails.** That
ordering is the whole reason unattended regeneration is safe: the generator only
transcribes, so without the gate a dependency that flipped to GPL would be
written into the notice by a bot and go green. Read the workflow's header before
editing it — the `pull_request_target` trigger, the two-job split that keeps
`contents: write` behind the guard, the manifest-only file guard, and
`pnpm install --ignore-scripts` are four controls that all carry weight.

**Setup, not yet done.** A push made with the default `GITHUB_TOKEN` does not
trigger new workflow runs, so until a token exists the workflow lands the commit
and the PR keeps showing its stale red checks — it warns in the job summary when
this happens. This repo currently has **no repository secrets or variables at
all** (`RELEASES_PAT` is named by `release.yml` but only ever as
`secrets.RELEASES_PAT || github.token`, so it has never been set). To finish the
setup, provision:

- repository **variable** `LICENSES_BOT_APP_CLIENT_ID`
- repository **secret** `LICENSES_BOT_APP_PRIVATE_KEY`

for a GitHub App installed on this repo with `contents: write` and nothing else.
Prefer that narrow App over a broadly-scoped PAT: the job installs
PR-controlled dependency versions, so a smaller token is a smaller blast radius.
`RELEASES_PAT` stays in the fallback chain if it is ever created.

**Dugite bumps are the deliberate exception.** They also need
`EMBEDDED_GIT_NOTICE_SOURCES` in `scripts/generate-third-party-licenses.mjs`
re-synced by hand, and that edit puts a `scripts/` file on the branch, which the
file guard rejects. A human finishes those — see [scripts/AGENTS.md](../../scripts/AGENTS.md).

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
