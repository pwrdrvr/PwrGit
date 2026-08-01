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
