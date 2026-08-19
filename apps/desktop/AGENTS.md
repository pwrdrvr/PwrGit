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

## better-sqlite3 is built twice, on purpose

`electron-rebuild` can only overwrite `build/Release`, so one binary would have
to be flipped every time you moved between `pnpm test` (Node's ABI) and
`pnpm dev` (Electron's) — and a stale flip reads like a broken test or a broken
database, not a stale build. `postinstall` runs
[scripts/rebuild-native-for-electron.mjs](scripts/rebuild-native-for-electron.mjs)
instead, which brackets the rebuild and keeps both binaries:

- `better-sqlite3/build/Release/better_sqlite3.node` — this machine's Node ABI.
  `vitest` and scripts load it through better-sqlite3's own `bindings()` lookup.
- `better-sqlite3/electron-native/better_sqlite3.node` — Electron's ABI, beside
  a `metadata.json` stamping the Electron version, better-sqlite3 version, and
  arch. [src/main/persistence/native-binding.ts](src/main/persistence/native-binding.ts)
  hands it to `new Database(path, { nativeBinding })` only while all three still
  match, and ignores it otherwise — a stale sidecar fails at `new Database()`,
  where no sidecar at all may still work.

Packaged builds ship no sidecar: electron-builder rebuilds `build/Release`
itself, once per packed arch, so a host-arch sidecar would be dead weight at
best. `electron-builder.yml` excludes `electron-native/` from the asar and
`scripts/verify-asar-contents.mjs` fails the build if it leaks in. (PwrSnap
ships its sidecar and builds a `lipo`-merged universal one for release; PwrGit
does not need that, because electron-builder's per-arch rebuild already
produces the universal `build/Release` binary that `release.mjs` verifies.)

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
