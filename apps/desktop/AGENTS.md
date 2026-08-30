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
