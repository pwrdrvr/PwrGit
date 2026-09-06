# apps/desktop — AGENTS.md

Notes for the desktop app. See the root `AGENTS.md` for setup + conventions.

## The main bundle is strict ESM — default-import CommonJS deps

`src/main/**` is bundled and run as ESM. A **named** import from a CommonJS
package throws at launch (`SyntaxError: Named export 'x' not found`), even
though it type-checks and bundles fine. Our CJS deps: `electron-updater`,
`dugite`, `better-sqlite3`.

```ts
import { autoUpdater } from "electron-updater"; // ✗ crashes at runtime
import electronUpdater from "electron-updater";  // ✓
const { autoUpdater } = electronUpdater;
```

`electron` itself and the ESM `@pwrdrvr/*` packages support named imports
normally. When adding a dependency used in `src/main`, check its `type` — if
`commonjs`, default-import it.

## better-sqlite3 is kept twice, on purpose

PwrGit keeps separately selected native-addon files for both runtimes even
though better-sqlite3 13 uses Node-API: one deterministic binary remains
selected for Node tests and scripts, while a separately stamped Electron
sidecar is verified for the app. Every supported platform stages the package's
platform/arch Node-API binary into both owned locations, avoiding a native
toolchain during a normal install. A stale or missing binary still
reads like a broken test or a broken database, not a native setup problem.
`postinstall` runs
[scripts/rebuild-native-for-electron.mjs](scripts/rebuild-native-for-electron.mjs)
instead, which brackets the rebuild and keeps both binaries:

- `better-sqlite3/build/Release/better_sqlite3.node` — this machine's Node ABI.
  `vitest` and scripts select it explicitly through
  [src/main/persistence/native-binding.ts](src/main/persistence/native-binding.ts).
- `better-sqlite3/electron-native/better_sqlite3.node` — Electron's ABI, beside
  a `metadata.json` stamping the Electron version, better-sqlite3 version, and
  arch. [src/main/persistence/native-binding.ts](src/main/persistence/native-binding.ts)
  hands it to `new Database(path, { nativeBinding })` only while all three still
  match, and ignores it otherwise — a stale sidecar fails at `new Database()`,
  where no sidecar at all may still work.

Packaged builds ship no sidecar. better-sqlite3 13 opts out of electron-builder's
implicit rebuild, so `scripts/beforepack-dugite-arch.mjs` stages the target
platform/arch prebuild at `build/Release` on each packaging pass and
`electron-builder.yml` disables the destructive default rebuild. It also
excludes both the dev-only `electron-native/` sidecar and the package's original
multi-platform `prebuilds/` directory; `scripts/verify-asar-contents.mjs` fails
the build if either leaks in. The universal merge combines the two Darwin
slices at the common `build/Release` path, and `release.mjs` verifies both
architectures.

## The packaging deps are pinned exact, not caret

`electron-builder` and `electron-updater` carry **exact** versions in
[package.json](package.json); everything else uses a caret. Packaging behavior
is verified by reading app-builder-lib's internals — how it derives the Windows
Add-or-Remove-Programs name, how it lays out the asar, which `electron-builder.yml`
keys it honors — and that reading is only worth doing once for the Pwr family if
all three repos resolve the same build. A caret silently re-resolves on any lock
refresh and quietly invalidates it.

Keep these pinned to the same versions as PwrSnap and PwrAgnt, and bump all
three together. Note that electron-builder's npm `latest` tag lags the 26.x
line (it currently points at 26.15.3 while `v26` is 26.15.7), so `npm view
electron-builder version` is not the version to pin — read the sibling repos.

## macOS app icon — ship the Icon Composer `.icon`; actool derives the `.icns`

`mac.icon` in [electron-builder.yml](electron-builder.yml) points at
`build/icon.icon`, an Icon Composer package written by
[scripts/generate-app-icon.swift](scripts/generate-app-icon.swift), and nothing
in this repo hand-builds a `.icns`. electron-builder (26.15+, pinned) compiles
the package with Xcode 26's `actool` into `Contents/Resources/Assets.car` +
`CFBundleIconName` (what macOS 26 draws) and derives the legacy
`Contents/Resources/icon.icns` + `CFBundleIconFile` (macOS 15 and earlier) from
the same source. Each OS reads the format designed for it.

Why this is an invariant: macOS 26 auto-normalizes a legacy `.icns` it is
handed *instead of* a `.icon`, and how it does so changed between 26.6.1 and
26.6.2. #187 padded the hand-built `.icns` to Apple's 824-in-1024 template —
the right shape for macOS 15 — and 26.6.2 composited that tile onto a light
plate in the Dock, Finder, and the DMG window. With the `.icon` present the
`.icns` is never opened on macOS 26. Ghostty (MIT) ships exactly this pair.

- **Regenerate with `pnpm --filter @pwrgit/desktop generate:app-icon`.** It
  writes the package (`icon.json` + a glyph-only `Assets/glyph.png`; the tile
  is the package `fill`), `icon.png` (full-bleed Windows/Linux master) and
  `icon-macos.png` (padded — the development Dock icon that
  [src/main/index.ts](src/main/index.ts) paints literally). Do not add a
  `.icns` / `.iconset` back, and do not point `mac.icon` at one.
- **Every job that packages the mac app needs a macOS 26 host and actool 26 or
  newer.** Xcode 26's `AssetCatalogAgent` loads host CoreMedia and MediaToolbox
  frameworks: selecting Xcode 26.3 on GitHub's `macos-15` runner crashes during
  Icon Composer compilation because those symbols are absent. The packaging
  lanes use `macos-26`, and the repo's `.github/actions/select-xcode-for-actool`
  checks that host prerequisite before finding the newest stable Xcode with
  actool 26+ and returning its Developer directory. `release.yml` (both macOS
  jobs) and `preview-build.yml` set `DEVELOPER_DIR` from it on exactly the
  steps that run actool — the unit tests, so the compile test in
  [scripts/branding-assets.test.ts](scripts/branding-assets.test.ts) runs
  instead of skips (that step also sets `PWRGIT_REQUIRE_ACTOOL=1`, so on the
  release lane the suite fails rather than skips when the probe finds no
  actool 26) — and electron-builder, so the icon compile does not move
  `build:native` onto a different toolchain. The sign job has no checkout, so
  the action rides inside the archived signing input. Locally, select an
  Xcode 26 (`xcode-select`, or `DEVELOPER_DIR`) before `package:dryrun`.
- **The compile test calls electron-builder's own helper**
  (`app-builder-lib/out/util/macosIconComposer.generateAssetCatalogForIcon`),
  not a copied actool command line, so the two cannot drift. If you compile
  by hand: `actool` resolves `--app-icon Icon` by the package's basename, so
  copy the package to `Icon.icon` first (fed `icon.icon` it exits 0 and
  silently writes no `.icns`), create the `--compile` directory, and check
  the output for the `.icns`.
- **actool's derived `.icns` carries 16, 32, 128 and 256px reps only** — the
  same four Ghostty ships. macOS 15 upsamples the 256px rep for Finder's
  largest icon sizes and Quick Look, where the deleted hand-built icns had 512
  and 1024. Accepted for now; an `afterPack` hook could splice larger reps
  rendered from `icon-macos.png` if it ever matters.
- **PNG bytes drift ±2/255 across macOS versions.** Regenerate when the
  artwork changes, not to "refresh".
- **Verify by asking macOS, on the newest macOS you ship to.** Render
  `NSWorkspace.shared.icon(forFile:)` and measure it; the recipe, the
  measurements, and the Ghostty comparison are in PwrSnap's
  `docs/solutions/2026-09-05-macos-26-legacy-icon-light-plate.md`
  (pwrdrvr/PwrSnap#563). A clean result on an older point release or on the
  GitHub runner proves nothing for this class.

## e2e needs a build first

`pnpm test:e2e` (Playwright) launches the BUILT app at `out/main/index.js` —
there is no dev-server fallback. On a fresh worktree, or after changing
`src/main/**`/`src/preload/**`, run `pnpm build` before `pnpm test:e2e` or
Electron dies with "Unable to find Electron app at .../out/main/index.js".

## Runtime facts

- IPC goes through the typed command bus (`command-bus.ts` / `ipc.ts`);
  handlers return `Result`, never throw across the boundary.
- Migrations are `.sql` files copied beside the bundle by `electron.vite.config.ts`.
- git runs through the injected `GitExec` (dugite in prod; system git in tests).
