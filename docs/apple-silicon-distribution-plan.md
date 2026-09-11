# Apple Silicon distribution exploration

Exploration dated 2026-09-11, based on PwrGit commit
`9b013a5c69fe3c513113b5c39c70cfea9b284f06` (v0.13.0 preparation).
No packaging configuration, production feeds, tags, releases, or website
repositories were changed. This document proposes implementation; its new
download URLs are not live promises.

## Recommendation

Add arm64 DMG and auto-update ZIP artifacts beside universal artifacts.
Continue supporting Intel through universal. Keep the app name, bundle IDs,
Developer ID identity, data directory, version, release tag selection, universal
filenames, and `latest-mac.yml` URL unchanged.

Use one `latest-mac.yml` containing both ZIP descriptors. The pinned
electron-updater already selects arm64 on Apple Silicon, including Rosetta,
and universal on Intel. Explicitly normalize the legacy top-level `path` and
`sha512` to universal; the pinned builder does not reliably do that for this
target combination. Separate architecture channel files are unnecessary for
the recommended migration.

Estimated benefit from a released bundle: **42.4% less installed logical file
data and 44.8% smaller ZIPs under identical recompression**. These are measured
estimates, not final signed arm64 package sizes. Do not market “half the size.”

## Current pipeline and constraints

- `apps/desktop/electron-builder.yml`: Electron 41.10.7; DMG and ZIP target
  universal only; hardened runtime, notarization, common entitlements and
  `com.pwrdrvr.pwrgit` identity; `dmg.writeUpdateInfo: false`. Windows NSIS x64
  remains separate. Debian x64/arm64 targets exist but are not published.
- `apps/desktop/package.json` pins electron-builder **26.15.7** and
  electron-updater **6.8.9**. Do not upgrade these as part of adding targets.
- `apps/desktop/scripts/release.mjs` prepares a flat production stage with
  `pnpm deploy`; hardcodes `--mac --universal`, `dist/mac-universal/PwrGit.app`,
  and checks x86_64 + arm64 slices in the app executable, SQLite and Git.
- `beforepack-dugite-arch.mjs` mutates the staged Git distribution and stages
  the target SQLite prebuild on each architecture pass. Do not run concurrent
  packaging processes against the same stage. Preserve its macOS GCM pruning
  for both products; changing runtime contents is outside this size comparison.
- `.github/workflows/release.yml` prepares without secrets, archives signing
  input with SHA-256, then signs/packages in the protected `apple-signing` job
  without checkout or dependency installation. Both macOS jobs use `macos-26`
  and selected actool 26+. This requirement applies to arm64 too.
- Signing currently runs `--sign-stage-only --no-publish`. The job copies the
  universal DMG to `PwrGit.dmg` and uploads DMG/ZIP/blockmaps plus
  `latest-mac.yml`. One later job waits for macOS, Azure-signed Windows and the
  Linux build gate before creating a GitHub Pre-release. Keep that boundary.
- `auto-updater.ts` chooses a tag from GitHub using Stable/Beta and
  Latest/Prerelease settings, then pins a **generic provider** to that tag's
  download directory. Its macOS availability check requires `latest-mac.yml`
  plus any ZIP. This check should become stricter with multiple architectures.
- The release skill still describes an unsigned Windows mode that current
  workflow/code have removed. Use current code and the release runbook as the
  pipeline evidence, and refresh the skill's artifact checklist during implementation.

## Size evidence and reproducibility

The latest promoted release returned by GitHub during this exploration was
[v0.11.0](https://github.com/pwrdrvr/PwrGit/releases/tag/v0.11.0), although the
worktree prepares v0.13.0. This is a historical payload measurement, not a
measurement of a fresh build of this worktree.

| Measurement | Universal | arm64 estimate | Reduction |
|---|---:|---:|---:|
| Logical regular-file bytes in extracted app | 619,358,759 | 356,575,783 | 262,782,976 bytes / 42.43% |
| ZIP, both repacked with identical `ditto` options | 257,503,379 | 142,143,535 | 115,359,844 bytes / 44.80% |
| Published updater ZIP | 248,444,968 | Not built | — |
| Published DMG | 257,354,691 | Not built | — |

The released ZIP is 3.5% smaller than our universal recompression, demonstrating
why comparing a differently compressed arm64 estimate directly with the
published ZIP is misleading. Applying the paired ratio to the published ZIP
suggests approximately **137 MB decimal**, but that is an extrapolation.
The measured arm64 recompression is **142 MB decimal**. Budget roughly
137–142 MB for this historical payload, pending real packaging; no DMG size
reduction is claimed without a paired DMG build.

Method:

1. Download the v0.11.0 universal ZIP and `latest-mac.yml` using `gh release
   download`; inspect release asset sizes using `gh release view --json assets`.
2. Extract with `ditto -x -k`, then copy the entire tree with `ditto`.
3. Walk regular files without following symlinks. For Mach-O fat magic values
   `cafebabe`, `bebafeca`, `cafebabf`, `bfbafeca`, verify architectures using
   `lipo -archs`, and replace each arm64-containing fat file in the copy using
   `lipo <file> -thin arm64 -output <temporary-file>`, preserving its mode.
4. Sum regular-file sizes excluding symlinks. Repack each tree using
   `ditto -c -k --sequesterRsrc --keepParent <PwrGit.app> <output.zip>`.

29 fat binaries were thinned. The Electron Framework accounts for
199,704,576 bytes of the reduction (378,875,856 → 179,171,280).
Git LFS contributes 13,451,264 bytes and libGLESv2 contributes 7,864,320.
JavaScript, fonts, licenses and other shared resources remain, so savings are
not exactly 50%. This method retains universal-only ancillary resources such
as any second-architecture snapshots; a true build may differ further.

These copies were never launched or distributed. Thinning invalidates the
release's signature seal; this is not a recipe for producing a release.
Logical bytes exclude APFS allocation, clones, extended attributes and update
caches. Report actual `du` allocation separately in the final benchmark.

Input ZIP SHA-256:
`c2029bddce7eaf708321b9a96d49ff09f449c8c84ec11234a24e42ba6a7e2ef6`.
Full per-binary measurements are in
[apple-silicon-size-evidence.json](apple-silicon-size-evidence.json).

## Updater evidence and routing

Inspected the exact npm tarballs, rather than assuming current online docs
match these pinned versions:

- [electron-updater 6.8.9](https://registry.npmjs.org/electron-updater/-/electron-updater-6.8.9.tgz),
  `out/MacUpdater.js`, `out/providers/Provider.js`.
- [app-builder-lib 26.15.7](https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.7.tgz),
  `out/publish/updateInfoBuilder.js`, `out/targets/ArchiveTarget.js` and
  `out/macPackager.js`.

The updater's `filterFilesForArch` checks the literal `arm64` substring in
artifact URLs. On Apple Silicon it prefers arm64 entries if present; on Intel
it excludes them. Hardware detection combines `process.arch`,
`sysctl.proc_translated`, and `uname`. If detection fails in an x64 process,
universal remains a safe fallback. Keep `arm64` in filenames and avoid that
substring in release tag names or parent paths shared by both artifacts.

Executed the pinned filter directly against fixture file descriptors: Apple
Silicon → arm64, Intel → universal, and Apple Silicon with only universal →
universal all passed. This proves file selection, not native installation.
The v0.11.0 tag pins the same updater; v0.1.0 declared `^6.8.9`. Audit resolved
lockfiles/bundled updater code for the oldest supported installed release
before claiming all historical clients behave identically.

On macOS, the provider appends `-mac` to `latest`; it does **not** append CPU
architecture. The builder similarly generates one macOS channel filename.
If two independent builds write into one directory, one manifest can overwrite
the other. Either build both in one controlled invocation and normalize the
result, or merge manifests explicitly before upload.

A source-level fixture executed the pinned `writeUpdateInfoFiles` with real
architecture enum values (arm64=3, universal=4) and mocked filesystem/event
sinks. It put arm64 first and set the legacy `path` to arm64. Its universal
priority special case is `arch === null`; `ArchiveTarget` forwards the numeric
architecture. Do not rely on its comment promising universal priority.

Required final shape (hashes and sizes computed from final signed ZIPs):

```yaml
version: <version>
files:
  - url: PwrGit-<version>-universal-mac.zip
    sha512: <universal SHA-512 base64>
    size: <universal ZIP bytes>
  - url: PwrGit-<version>-arm64-mac.zip
    sha512: <arm64 SHA-512 base64>
    size: <arm64 ZIP bytes>
path: PwrGit-<version>-universal-mac.zip
sha512: <universal SHA-512 base64>
releaseDate: <release timestamp>
```

| Existing installation | Next update with both ZIPs | Qualification |
|---|---|---|
| Universal, native Apple Silicon | arm64 app | Pinned filter supported; signed replacement smoke required |
| Universal, Rosetta on Apple Silicon | arm64 app, native after restart | Test forced-Rosetta launch and resulting restart |
| Universal, Intel | universal app | arm64 descriptors excluded |
| arm64, Apple Silicon | arm64 app | Normal subsequent update |
| Legacy client using top-level descriptor | universal app | Explicit universal `path`/hash preserve fallback |
| Apple Silicon, release has universal ZIP only | universal app | Existing updater supports fallback |

Do not expect a same-version universal installation to switch architecture:
normal updates need a newer version. Explicit DMG replacement is available
for a same-version manual switch. A migrated arm64 app cannot subsequently
be copied to an Intel Mac; the universal DMG remains available for that use.
Do not promise that manually choosing universal on Apple Silicon keeps future
updates universal unless a separate user preference is implemented.

The first architecture transition may download the full ZIP. The updater
uses cached `update.zip` plus blockmaps for differential download and falls
back to a full download when unavailable or unsuccessful. Existing cache bytes
are not part of installed app savings. Test missing old arm64 blockmaps and
cross-tag blockmap URL handling; keep full-download fallback working.

Alternative if historical-client testing blocks shared metadata: leave
`latest-mac.yml` universal-only and introduce an explicit `latest-arm64-mac.yml`
using generic provider channel `latest-arm64` in new clients. That requires
architecture-aware availability checks, Rosetta-aware selection, explicit
fallback and a bridge update for existing clients. Merely publishing
`latest-mac-arm64.yml` will not make current clients request it. Prefer the
shared manifest unless testing establishes a need for this extra mechanism.

## Concrete implementation sequence

1. **Build both products safely.** Add DMG/ZIP arm64 alongside universal in
   `electron-builder.yml`; replace the forced universal CLI selector in
   `release.mjs` with validated macOS target selection. Prefer sequential
   packaging into separate output directories from the prepared stage, then
   collect artifacts and merge descriptors. Keep `--no-publish` in CI.
   If using one invocation, verify builder scheduling cannot race the mutable
   beforePack stage. Do not thin an already signed universal app to ship arm64.
2. **Keep artifact names explicit.** Preserve
   `PwrGit-<version>-universal.dmg`,
   `PwrGit-<version>-universal-mac.zip` and its `.blockmap`; add
   `PwrGit-<version>-arm64.dmg`,
   `PwrGit-<version>-arm64-mac.zip` and its `.blockmap`.
   Keep `PwrGit.dmg` an exact universal copy; add `PwrGit-arm64.dmg` as an exact
   arm64 copy. Do not replace the old alias with arm64.
3. **Sign and notarize independently.** Keep the same Developer ID, bundle
   identity, entitlements and hardened runtime. Each completed app must pass
   signing and notarization before ZIP/DMG creation. Verify stapling of each
   app, `codesign --verify --deep --strict`, and Gatekeeper assessment of
   downloaded/quarantined packages. No signing keys or secrets are added.
4. **Generalize verification.** Check both output apps; require exactly arm64
   for the thin app and x86_64+arm64 for universal. Include Electron Framework,
   helper executables, SQLite, Git, Git LFS and bundled dylibs, not just the
   existing three paths. Run existing ASAR and license-notice verifiers on
   each product. Smoke launch, SQLite access and embedded Git on both CPUs.
5. **Assemble metadata after packaging.** Add a small manifest assembly and
   validation script, include it in the verified signing-input archive, and
   invoke it before workflow artifact upload. Require matching versions,
   exactly one ZIP per expected architecture, valid SHA-512/size, universal
   legacy fallback, blockmaps, exact aliases and no duplicate asset basenames.
   Never merge with a manifest left over from an earlier build.
6. **Tighten updater eligibility.** Replace the “any ZIP” macOS check with
   recognized artifact checks so Intel cannot be offered an arm64-only
   incomplete release. Keep selection by tag and the existing four settings
   slots unchanged. Validate completeness server-side before publication too;
   already-installed clients retain their older permissive check.
7. **Extend release gates and tests.** Update `release-config.test.mjs`,
   `auto-updater.test.ts`, the metadata checker, preview workflow, workflow
   README, desktop runbook, desktop AGENTS and release skill asset checklist.
   Keep one final publisher and existing Windows/Linux gates. Include both
   macOS outputs before release creation; assess the 60-minute sign-job timeout
   from actual dual-package timings. A separate signing matrix may be useful
   later, but needs isolated stage copies and a deterministic aggregation job.
8. **Validate before promotion.** Run `pnpm lint`, `pnpm test`, `pnpm build`,
   release metadata gate, and paired packaging measurements on the same
   commit. Use a controlled test feed for signed N→N+1 updates on real Intel,
   native Apple Silicon and Rosetta. Exercise manual DMG replacement, all four
   settings slots, cached universal ZIP, absent/corrupt arm64 metadata,
   interrupted download, full-download fallback, and a later universal-only
   recovery release. Confirm profiles/settings/data survive restart. This
   exploration did not run these signing or end-to-end checks.

## Website and README rollout

Read-only inspection confirmed separate Jekyll repositories:

| Repository | Files to change | Work |
|---|---|---|
| `pwrdrvr/pwrgit.com` | `_config.yml`, `_layouts/default.html`, `index.md`, `assets/js/site.js`, optionally `assets/css/site.css` | Add arm64 URL/suffix/data attributes, distinct download choices and size badges, architecture selection, accessible fallback |
| `pwrdrvr/docs.pwrgit.com` | `install.md`, optionally `_data/nav.yml` | Explain Apple Silicon/universal selection and automatic migration; add a real Debian instructions destination |
| `pwrdrvr/PwrGit` | `README.md`, `docs/assets/buttons/` if retaining image buttons | Put Apple Silicon first and most prominent, with universal, Windows and Debian instructions immediately alongside |

The marketing script currently detects only OS, uses a universal macOS CTA,
and resolves Windows assets/version/size through a cached latest-release API
response. Expand its summary from `mac` to `macArm64` and `macUniversal` and
bump its session-cache key. Update hero, other-platform choices, install cards,
labels and badges together. Do not show universal size next to an arm64 link.

On a desktop Mac, feature-detect
`navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness'])`.
Only a macOS platform result with `architecture: 'arm'` and `bitness: '64'`
selects arm64 automatically. An x86 result can safely use universal; unknown,
empty, rejected, timed-out or unsupported hints must retain universal or show
an explicit chooser. This API is designed to expose architecture for binary
selection, but availability and disclosure are conditional. See the
[User-Agent Client Hints specification](https://wicg.github.io/ua-client-hints/#download)
and its architecture and permissions sections.

Do not infer Intel from `MacIntel` or a macOS UA string; do not use WebGL GPU
fingerprinting. Keep iPad/mobile exclusions. Always show “Apple Silicon” and
“Universal (Intel + Apple Silicon)” manual choices, including with JavaScript
disabled. Use a bounded asynchronous hint lookup and never override a user's
explicit selection when a late result arrives. Windows keeps its existing
asset resolver. Debian links to instructions rather than a guessed binary.

Deploy link changes only after the first dual-artifact stable release is
promoted and aliases return successfully. Until then an arm64 choice can link
to the latest release page with accurate availability copy. Keep the existing
universal no-JavaScript fallback. Test Safari/Firefox without hints,
Chromium arm64/x86/empty/rejected hints, iPad desktop UA, API failure, cached
old releases, keyboard operation and downloading for a different machine.

Proposed README download block, to apply when destinations exist:

```markdown
**[Download for Apple Silicon](https://github.com/pwrdrvr/PwrGit/releases/latest/download/PwrGit-arm64.dmg)**

[Universal macOS — Intel + Apple Silicon](https://github.com/pwrdrvr/PwrGit/releases/latest/download/PwrGit.dmg)
· [Windows x64](https://github.com/pwrdrvr/PwrGit/releases/latest)
· [Debian installation instructions](https://docs.pwrgit.com/install/#debian)

macOS 12 or newer. Both Mac downloads are signed and notarized.
Choose universal if you're unsure which Mac you have.
```

Replace the existing generic macOS hero image with a clearly labeled Apple
Silicon primary button if maintaining the visual treatment. Keep the docs
link, but ensure other platform links are visible near the primary download.
Update “Get it” and “Roadmap” in the same README change.

**Debian dependency:** current docs explicitly say no Linux package; there is
no `#debian` installation section. The companion docs change must either
provide verified source-build instructions honestly labeled experimental, or
wait for separately scoped Debian distribution work. Do not invent an apt
repository/install command or imply Debian artifacts ship in this release.

## Open decisions

1. Adopt automatic universal→arm64 migration on Apple Silicon (recommended),
   or add an explicit “keep universal” preference for portable installations?
2. What is the oldest installed release requiring a tested upgrade path?
   Validate its resolved updater, not just its declared version range.
3. Is a local Debian source-install guide sufficient for the requested link,
   or is published Debian distribution a separate prerequisite?
4. Confirm `PwrGit-arm64.dmg` as the permanent new alias and decide whether
   macOS checksum manifests should be added with it.
5. Confirm sign-job runtime and actual signed DMG/ZIP/installed sizes before
   publishing any size claim. The current measurement supports substantial
   savings but does not replace that acceptance gate.

Intel-only artifacts are deferred: universal meets Intel support requirements
and preserves URLs, while a third product would add signing time, metadata
cases and release storage. Revisit only with evidence of enough Intel demand.
