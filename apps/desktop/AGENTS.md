# apps/desktop — AGENTS.md

Read the root `AGENTS.md` for setup and conventions.

## The main bundle is strict ESM — default-import CommonJS deps

`src/main/**` runs as ESM. A **named** import from a CommonJS package
type-checks and bundles, then throws at launch:
`SyntaxError: Named export 'x' not found`. Our CJS deps are `electron-updater`,
`dugite` and `better-sqlite3`.

```ts
import { autoUpdater } from "electron-updater"; // ✗ crashes at runtime
import electronUpdater from "electron-updater";  // ✓
const { autoUpdater } = electronUpdater;
```

`electron` and the ESM `@pwrdrvr/*` packages accept named imports. If a new
`src/main` dependency has `type: commonjs`, default-import it.

## better-sqlite3 is kept twice, on purpose

better-sqlite3 13 uses Node-API, but PwrGit keeps one addon file per runtime.
`postinstall`
([scripts/rebuild-native-for-electron.mjs](scripts/rebuild-native-for-electron.mjs))
stages the platform/arch Node-API binary into both locations, with no native
toolchain. A stale or missing binary looks like a broken test or database.

- `better-sqlite3/build/Release/better_sqlite3.node`: Node ABI. `vitest` and
  scripts select it through
  [src/main/persistence/native-binding.ts](src/main/persistence/native-binding.ts).
- `better-sqlite3/electron-native/better_sqlite3.node`: Electron's ABI. A
  `metadata.json` stamps Electron version, better-sqlite3 version and arch.
  `native-binding.ts` passes it to `new Database(path, { nativeBinding })`
  only while all three match. A stale sidecar fails at `new Database()`; no
  sidecar can still work.

Packaged builds ship no sidecar:

- better-sqlite3 13 opts out of electron-builder's implicit rebuild;
  `electron-builder.yml` disables the destructive default rebuild.
  `scripts/beforepack-dugite-arch.mjs` stages the target prebuild at
  `build/Release` per packaging pass.
- `electron-builder.yml` excludes `electron-native/` and the multi-platform
  `prebuilds/` directory. `scripts/verify-asar-contents.mjs` fails the build if
  either leaks in.
- The universal merge combines both Darwin slices at `build/Release`.
  `release.mjs` verifies both architectures.

## The Electron binary is downloaded by our postinstall

Since Electron 42, `electron` fetches its binary on the first
`require("electron")`. electron-vite only reads `path.txt` (`pnpm dev` fails
with "Electron uninstall"), and parallel Playwright workers would race. So
`postinstall` runs
[scripts/install-electron-binary.mjs](scripts/install-electron-binary.mjs)
first. Repair a missing `dist/` with
`pnpm --filter @pwrgit/desktop run install:electron-binary`.

A major Electron bump also changes:

- `electronVersion` and `LSMinimumSystemVersion` in
  [electron-builder.yml](electron-builder.yml).
- `THIRD_PARTY_LICENSES` (`pnpm licenses:generate`).
- The README's macOS floor.
- A raised floor needs a PR on `pwrdrvr/homebrew-tap`. Its publisher only
  rewrites `version`/`sha256`, though
  [package-manager-release.mjs](../../scripts/package-manager-release.mjs)
  derives `depends_on macos:` from `LSMinimumSystemVersion`.

electron-vite 5.0.0 maps majors only through 39, then uses `node22.20` /
`chrome142`. These are older than the runtime, so safe.

## The packaging deps are pinned exact, not caret

- `electron-builder` and `electron-updater` have **exact** versions in
  [package.json](package.json). Everything else uses a caret.
- Why: we verify packaging by reading app-builder-lib's internals (Windows
  Add-or-Remove-Programs name, asar layout, honored `electron-builder.yml`
  keys). That holds for the Pwr family only if all three repos resolve the same
  build. A caret re-resolves silently on a lock refresh.
- Keep the pins identical to PwrSnap and PwrAgnt; bump all three together.
  Read the sibling repos for the version. npm's `latest` tag can lag `v26`
  (`npm view electron-builder dist-tags`), so do not pin
  `npm view electron-builder version`.

## macOS app icon — ship the Icon Composer `.icon`; actool derives the `.icns`

`mac.icon` in [electron-builder.yml](electron-builder.yml) is
`build/icon.icon`, an Icon Composer package from
[scripts/generate-app-icon.swift](scripts/generate-app-icon.swift). Nothing
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
  [src/main/index.ts](src/main/index.ts)). Never add a `.icns` / `.iconset` or
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
    [scripts/branding-assets.test.ts](scripts/branding-assets.test.ts) does
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

## e2e needs a build first

`pnpm test:e2e` launches the BUILT app at `out/main/index.js`, with no
dev-server fallback. Run `pnpm build` first on a fresh worktree and after
changes to `src/main/**` or `src/preload/**`. Otherwise Electron dies with
"Unable to find Electron app at .../out/main/index.js".

## Profiling the renderer with React DevTools

Before you profile, read
[docs/react-devtools-profiling.md](../../docs/react-devtools-profiling.md).
The **build** (`electron.vite.config.ts`), not the app, reads
`PWRGIT_REACT_DEVTOOLS=1` and `PWRGIT_REACT_PROFILING=1`. Use the dev build for
re-render storms, the profiling build only for millisecond numbers. Always:

- Do not add `react-devtools` to `package.json`. It pulls in a second Electron
  (`electron@^23`).
- Do not weaken `verify-asar-contents.mjs`. It fails packaging when shipped
  HTML loads a remote `<script src>` (rules in `packaged-html-rules.mjs`), so
  a bridged build cannot ship.

## Runtime facts

- IPC goes through the typed command bus (`command-bus.ts` / `ipc.ts`).
  Handlers return `Result` and never throw across the boundary.
- `electron.vite.config.ts` copies the `.sql` migrations beside the bundle.
- git runs through the injected `GitExec`: `execGit` in prod, `createSystemGit`
  in tests. Both run the bundled Git by default. `src/main/git/AGENTS.md` lists
  the exceptions.
- The app log is `app.getPath("logs")/main.log` (`~/Library/Logs/PwrGit` on
  macOS, else `<userData>/logs`). `src/main/logs.ts` buffers it for Help › Logs.
  - `src/main/process-ids.ts` logs the main, GPU, renderer and utility pids,
    so a pasted log names its processes.
  - `src/main/event-loop-stalls.ts` warns `(process) main event loop blocked
    for Nms` when main was held ≥2 s. Grep for it before you read a log gap as
    idle time.
- `logMain` uses scoped `electron-log` loggers (as in PwrSnap/PwrAgnt):
  console, file, 2 MiB rotation (`main.old.log`), and a file hook to the Logs
  window. Info+ goes to the terminal; debug only to file and Logs window. `log-console.ts` guards closed stdio pipes. Await
  `initLogFile` before startup logging; it keeps pre-0.14 history.

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
