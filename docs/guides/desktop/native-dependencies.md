# Desktop native dependencies

This guide covers how the desktop app loads CommonJS dependencies, stages better-sqlite3 and the Electron binary, and pins its packaging dependencies.

Code paths in backticks are relative to [apps/desktop](../../../apps/desktop/).

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
([scripts/rebuild-native-for-electron.mjs](../../../apps/desktop/scripts/rebuild-native-for-electron.mjs))
stages the platform/arch Node-API binary into both locations, with no native
toolchain. A stale or missing binary looks like a broken test or database.

- `better-sqlite3/build/Release/better_sqlite3.node`: Node ABI. `vitest` and
  scripts select it through
  [src/main/persistence/native-binding.ts](../../../apps/desktop/src/main/persistence/native-binding.ts).
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
[scripts/install-electron-binary.mjs](../../../apps/desktop/scripts/install-electron-binary.mjs)
through [ensure-electron-runtime.mjs](../../../apps/desktop/scripts/ensure-electron-runtime.mjs), which
shares PwrAgent’s verified extraction cache and installs independent runtime
copies (native APFS clones on macOS). Protocol and headless allocation oracle:
[docs/electron-runtime-cache.md](../../electron-runtime-cache.md).
Repair a missing `dist/` with
`pnpm --filter @pwrgit/desktop run install:electron-binary`.

A major Electron bump also changes:

- `electronVersion` and `LSMinimumSystemVersion` in
  [electron-builder.yml](../../../apps/desktop/electron-builder.yml).
- `THIRD_PARTY_LICENSES` (`pnpm licenses:generate`).
- The README's macOS floor.
- A raised floor needs a PR on `pwrdrvr/homebrew-tap`. Its publisher only
  rewrites `version`/`sha256`, though
  [package-manager-release.mjs](../../../scripts/package-manager-release.mjs)
  derives `depends_on macos:` from `LSMinimumSystemVersion`.

electron-vite 5.0.0 maps majors only through 39, then uses `node22.20` /
`chrome142`. These are older than the runtime, so safe.

## The packaging deps are pinned exact, not caret

- `electron-builder` and `electron-updater` have **exact** versions in
  [package.json](../../../apps/desktop/package.json). Everything else uses a caret.
- Why: we verify packaging by reading app-builder-lib's internals (Windows
  Add-or-Remove-Programs name, asar layout, honored `electron-builder.yml`
  keys). That holds for the Pwr family only if all three repos resolve the same
  build. A caret re-resolves silently on a lock refresh.
- Keep the pins identical to PwrSnap and PwrAgnt; bump all three together.
  Read the sibling repos for the version. npm's `latest` tag can lag `v26`
  (`npm view electron-builder dist-tags`), so do not pin
  `npm view electron-builder version`.
