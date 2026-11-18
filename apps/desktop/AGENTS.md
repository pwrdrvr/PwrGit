# apps/desktop — AGENTS.md

Read the root `AGENTS.md` for setup and conventions.

## Rust MCP helper

Run `pnpm build:native` explicitly for the host helper. Install, Dev, ordinary
JavaScript builds and test hooks never invoke Rust. After Rust source changes,
rebuild before testing native MCP. CI builds it explicitly before transport
tests; release staging passes `--universal`. Missing Cargo on an explicit native
build is an error; do not add automatic compilation or missing-tool fallbacks
to setup or Dev.

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

If a new `src/main` dependency has `type: commonjs`, default-import it.

## better-sqlite3 is kept twice, on purpose

`postinstall` stages one better-sqlite3 binary for Node (vitest) and one for
Electron. A stale or missing binary looks like a broken test or database.
Packaged builds ship no Electron sidecar.
Read [Desktop native
dependencies](../../docs/guides/desktop/native-dependencies.md#better-sqlite3-is-kept-twice-on-purpose)
before changing native staging, `native-binding.ts` or packaging excludes.

## The Electron binary is downloaded by our postinstall

`postinstall` installs the Electron binary through a shared verified cache.
Repair a missing `dist/` with
`pnpm --filter @pwrgit/desktop run install:electron-binary`.
Read [Desktop native
dependencies](../../docs/guides/desktop/native-dependencies.md#the-electron-binary-is-downloaded-by-our-postinstall)
before changing Electron install scripts or bumping an Electron major.

## The packaging deps are pinned exact, not caret

`electron-builder` and `electron-updater` have exact versions. Keep them
identical to PwrSnap and PwrAgnt, and bump all three together.
Read [Desktop native
dependencies](../../docs/guides/desktop/native-dependencies.md#the-packaging-deps-are-pinned-exact-not-caret)
before bumping either package.

## macOS app icon — ship the Icon Composer `.icon`; actool derives the `.icns`

`mac.icon` is the Icon Composer package `build/icon.icon`. Never add a
`.icns` / `.iconset` or point `mac.icon` at one. Regenerate with
`pnpm --filter @pwrgit/desktop generate:app-icon`. Packaging the mac app
needs a macOS 26 host and actool 26 or newer.
Read [Desktop packaging and
release](../../docs/guides/desktop/packaging-and-release.md#macos-app-icon--ship-the-icon-composer-icon-actool-derives-the-icns)
before changing the icon, its generator, or a job that packages the mac app.

## e2e needs a build first

Full-app E2E opens real desktop windows, including without `--headed`. Run it
through Control MCP on the dedicated lab VM; read
[the lab procedure](../../docs/headed-e2e-pwrsuitelab.md) first. The guest's
`test:e2e` pretest builds `out/main/index.js`. A direct Playwright invocation
needs that build in the guest first. Hidden harnesses need no app build.

## Profiling the renderer with React DevTools

Do not add `react-devtools` to `package.json`. Do not weaken
`verify-asar-contents.mjs`.
Read [Desktop runtime and
diagnostics](../../docs/guides/desktop/runtime-and-diagnostics.md#profiling-the-renderer-with-react-devtools)
and [docs/react-devtools-profiling.md](../../docs/react-devtools-profiling.md)
before you profile.

## Runtime facts

- IPC goes through the typed command bus (`command-bus.ts` / `ipc.ts`).
  Handlers return `Result` and never throw across the boundary.
- git runs through the injected `GitExec`. `src/main/git/AGENTS.md` lists
  the exceptions.
- The app log is `app.getPath("logs")/main.log`. Grep it for `main event loop
  blocked` before you read a log gap as idle time.

Read [Desktop runtime and
diagnostics](../../docs/guides/desktop/runtime-and-diagnostics.md#runtime-facts)
before changing migrations, logging or startup log order, or investigating
CPU and energy use.

## macOS release architectures

Keep `scripts/afterpack-macos-uuid.mjs` before signing, and keep `arm64` in
arm64 asset names. Add every script a sign job imports to that job's
signing-input archive; a script that `release.mjs` imports goes in both.
Direct macOS publication is blocked; use the release workflow.
Read [Desktop packaging and
release](../../docs/guides/desktop/packaging-and-release.md#macos-release-architectures)
before changing mac targets, release scripts or sign jobs.

## Linux launcher icons

`linux.icon` points to the `build/icons/` hicolor family. Do not point Linux
at the 1024px master.
Read [Desktop packaging and
release](../../docs/guides/desktop/packaging-and-release.md#linux-launcher-icons)
before changing Linux icons.

## Windows installer names

**Never rename the versioned installer**: electron-updater fetches it by the
name in `latest.yml`. The stable alias is copied only after Authenticode
verification.
Read [Desktop packaging and
release](../../docs/guides/desktop/packaging-and-release.md#windows-installer-names)
before changing Windows artifacts or `windows-release-artifacts.mjs`.
