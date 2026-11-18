# Desktop packaging and release

This guide covers app icons, macOS release architectures, signing-input archives and Windows installer names for packaged desktop builds.

## macOS app icon — ship the Icon Composer `.icon`; actool derives the `.icns`

`mac.icon` in [electron-builder.yml](../../../apps/desktop/electron-builder.yml) is
`build/icon.icon`, an Icon Composer package from
[scripts/generate-app-icon.swift](../../../apps/desktop/scripts/generate-app-icon.swift). Nothing
hand-builds a `.icns`. electron-builder (26.15+, pinned) compiles it with
Xcode 26's `actool` into `Contents/Resources/Assets.car` + `CFBundleIconName`
(macOS 26) and `Contents/Resources/icon.icns` + `CFBundleIconFile` (macOS 15
and earlier).

Why: macOS 26 auto-normalizes a `.icns` it gets *instead of* a `.icon`.
macOS 26.6.2 put #187's hand-built `.icns` (Apple's 824-in-1024 template,
correct for macOS 15) on a light plate in the Dock, Finder and DMG window;
26.6.1 did not. With the `.icon` present, macOS 26 never opens the `.icns`.
Ghostty (MIT) ships the same pair.

- **Regenerate with `pnpm --filter @pwrgit/desktop generate:app-icon`.** It
  writes the package (`icon.json` + glyph-only `Assets/glyph.png`; the tile is
  the package `fill`), `icon.png` (full-bleed Windows/Linux master) and
  `icon-macos.png` (padded dev Dock icon, painted literally by
  [src/main/index.ts](../../../apps/desktop/src/main/index.ts)). Never add a `.icns` / `.iconset` or
  point `mac.icon` at one.
- **Every job that packages the mac app needs a macOS 26 host and actool 26 or
  newer.**
  - Xcode 26's `AssetCatalogAgent` needs host CoreMedia and MediaToolbox
    symbols. `macos-15` lacks them (Xcode 26.3 crashes there), so packaging
    lanes use `macos-26`.
  - `.github/actions/select-xcode-for-actool` checks the host, then returns
    the Developer directory of the newest stable Xcode with actool 26+.
  - `release.yml` (both macOS jobs) and `preview-build.yml` set
    `DEVELOPER_DIR` only on the actool steps: unit tests (so
    [scripts/branding-assets.test.ts](../../../apps/desktop/scripts/branding-assets.test.ts) does
    not skip its compile test) and electron-builder (so `build:native` keeps
    its toolchain). The release test step sets `PWRGIT_REQUIRE_ACTOOL=1`, so a
    missing actool 26 fails the suite.
  - The sign job has no checkout, so the action is in the signing input.
  - Locally, select an Xcode 26 (`xcode-select` or `DEVELOPER_DIR`) before
    `package:dryrun`.
- **The compile test calls electron-builder's own helper**
  (`app-builder-lib/out/util/macosIconComposer.generateAssetCatalogForIcon`),
  not a copied actool command line, so the two cannot drift.
- **To compile by hand,** copy the package to `Icon.icon`: `actool` resolves
  `--app-icon Icon` by basename, and with `icon.icon` exits 0 with no `.icns`.
  Create the `--compile` directory. Check the output for the `.icns`.
- **actool's `.icns` has only 16, 32, 128 and 256px reps**, like Ghostty's.
  macOS 15 upsamples 256px for Finder's largest sizes and Quick Look (the old
  icns had 512 and 1024). Accepted; an `afterPack` hook could add larger reps
  from `icon-macos.png`.
- **PNG bytes drift ±2/255 across macOS versions.** Regenerate only when the
  artwork changes.
- **Verify by asking macOS, on the newest macOS you ship to.** Render
  `NSWorkspace.shared.icon(forFile:)` and measure it. Recipe, measurements and
  Ghostty comparison: PwrSnap's
  `docs/solutions/2026-09-05-macos-26-legacy-icon-light-plate.md`
  (pwrdrvr/PwrSnap#563). An older point release or a GitHub runner proves
  nothing.

## macOS release architectures

- `scripts/afterpack-macos-uuid.mjs` personalizes only the staged main
  executable's `LC_UUID`, also on the universal pass. Keep it before signing:
  the signature covers the UUID bytes.
- The hash uses app ID, app version, Electron version, CPU type and subtype.
  Never hash the previous UUID; the universal pass must be idempotent. Bundle
  IDs and signing identity do not change. `.github/workflows/README.md` has
  verification and symbol caveats.
- DMG and ZIP targets build universal and arm64. Keep `concurrency.jobs: 1`:
  `beforePack` mutates the shared stage's Git and SQLite files per
  architecture.
- `release.mjs` verifies both app trees. `mac-release-artifacts.mjs` then
  writes one `latest-mac.yml` and the stable DMG aliases. Universal stays the
  legacy `path`/`sha512` fallback and the `PwrGit.dmg` alias.
- Keep `arm64` in arm64 asset names. electron-updater selects the architecture
  by that substring.

**Add every script a sign job imports to that job's signing-input archive:**
the `tar` list in `.github/workflows/release.yml` (macOS) or `$archiveInputs`
in `scripts/release/archive-windows-signing-input.ps1` (Windows). A script
that `release.mjs` imports goes in **both**.

- Why: sign jobs run from the tarball, not a checkout. An unlisted
  `import "./x.mjs"` fails with `ERR_MODULE_NOT_FOUND` at release time. No PR
  catches it: packaging lanes skip on pull requests.
- `mac-release-artifacts.mjs`, `windows-release-artifacts.mjs` and
  `packaged-html-rules.mjs` are in both archives.
  `stage-better-sqlite3-arch.mjs` is only in the `release.yml` list, because
  `beforepack-dugite-arch.mjs` imports it.

**Direct macOS publication is blocked.** Use the release workflow; it uploads
only after validation.

## Linux launcher icons

- `linux.icon` points to `build/icons/`, a hicolor family that
  `pnpm --filter @pwrgit/desktop generate:linux-icons` derives from
  `build/icon.png`. `generate:app-icon` runs it after the master.
- Do not point Linux at the 1024px master. The pinned builder keeps that size,
  and hicolor cannot find a `1024x1024` directory.
- Package validation checks icon names and sizes; native CI resolves the
  installed DEB icon through GTK.

## Windows installer names

`windows-release-artifacts.mjs` owns the `SHA256SUMS` manifest (packaging
writes it, a later step parses it; keep both halves in this file) and the
stable `PwrGit.Setup.exe` alias beside the versioned installer.

- `release.yml`'s `windows-sign` job copies the alias byte-for-byte *after*
  Authenticode verification. A copy made during packaging would be unsigned.
- That step asserts the alias exists: a no-op script exits 0, and
  `upload-artifact` only warns when one of several globs matches nothing.
- **Never rename the versioned installer.** `latest.yml` names it, and
  electron-updater fetches it by that name.
- The alias has no space. GitHub Releases changes spaces to periods, which a
  rename cannot undo, so the build output would not match the published asset.
- Windows ARM uses `PwrGit.Setup.Arm.exe`. It intentionally differs from
  `PwrGit-arm64.dmg`, whose URL is already published.
- Aliases stay out of `SHA256SUMS`: same bytes, second name.
- Operator-facing version: `.github/workflows/README.md`.
