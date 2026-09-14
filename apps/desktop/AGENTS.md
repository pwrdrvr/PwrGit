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

## Profiling the renderer with React DevTools

Nothing in the app connects React DevTools on its own. Two opt-in env vars,
both read by [`electron.vite.config.ts`](electron.vite.config.ts) at Vite
config time, turn it on:

| Variable | What it does |
|---|---|
| `PWRGIT_REACT_DEVTOOLS=1` | Injects `<script src="http://localhost:8097">` as the first `<head>` script so the renderer loads the standalone DevTools backend. |
| `PWRGIT_REACT_DEVTOOLS_HOST` / `_PORT` | Point that script somewhere other than `localhost:8097`. |
| `PWRGIT_REACT_PROFILING=1` | Aliases `react-dom/client` → `react-dom/profiling` for `electron-vite build` only. |

Both use the repo's usual on/off allowlist (`1`, `true`, `yes`, `on`); `false`,
`off` and `no` are off. With them unset the plugin is never constructed and the
alias key is never added, so a normal build is byte-identical to one from a
tree without this feature — verified by building from both configs and diffing
`out/renderer`, 38 files, no difference.

Unlike every other `PWRGIT_*` flag, these two are read by the **build** rather
than by the app process — `electron.vite.config.ts` consumes them at Vite config
time, and the running app never looks at them. So there is no
`rejectDevOnlyEnvVarsInProduction` in `src/main` to register them with, and a
packaged app says nothing when one is exported. The packaging gate below is
what actually stops a bridged build.

### Attaching to the dev build

This is the configuration to reach for first, and it needs no build changes.

```bash
npx react-devtools
```

Then, from the repository root, start this checkout with the bridge enabled:

```bash
PWRGIT_REACT_DEVTOOLS=1 pnpm dev
```

`npx react-devtools` must already be listening when the renderer loads; the
script tag is a synchronous classic script, and a refused connection simply
means React never registers a renderer with the hook. `src/renderer/index.html`
carries no CSP and main sets none, so the tag has nothing to fight.

Do not add `react-devtools` to `package.json`. It depends on `electron@^23`,
which would pull a second Electron runtime into `node_modules` alongside the
one the app actually uses.

### Knowing which instance you attached

Several PwrDrvr Electron apps — PwrGit, PwrSnap, PwrAgnt, and more than one
checkout of each — usually run at once on this machine, and the standalone
DevTools listens on a single port and says nothing about which page is on the
other end of its socket. **Do not restart or drive another session's running
instance to find out.** Two things settle it without touching anything else:

- The bridge is opt-in per process. An instance started without
  `PWRGIT_REACT_DEVTOOLS=1` has no script tag and *cannot* connect, so
  starting exactly one bridged instance is itself the isolation.
- The injected bridge logs its endpoint and the checkout it was built from to
  the renderer console:
  `[pwrgit] React DevTools bridge -> http://localhost:8097 (renderer from /…/apps/desktop)`.
  Open that window's own Electron DevTools and read the line to confirm the
  window in front of you is the one on the socket.

To profile two checkouts at once, give each its own port and run one
`react-devtools` per port:

```bash
npx react-devtools --port 8098
PWRGIT_REACT_DEVTOOLS=1 PWRGIT_REACT_DEVTOOLS_PORT=8098 pnpm dev
```

Every window in the process loads the same renderer bundle, so auxiliary
windows (Settings, Logs, the document windows) carry the bridge too. The
standalone server accepts one connection at a time and logs a warning when it
replaces an earlier one.

### Which build to use for what

**Use the dev build to find re-render storms and update loops.** It is the
better tool for that, not a fallback:

- The Profiler's "Record why each component rendered" attribution is richer in
  a development build — it reports the specific changed props by name and the
  changed hook indices (`Hook 7 changed`). The production profiling build drops
  some of that detail.
- No build step, no packaging, and HMR still works.
- A pathology shows up as a *ratio* — components re-rendered per commit, or
  commits per interaction — and ratios survive the dev build's overhead intact.

**Use the profiling build only when an absolute millisecond number has to be
trustworthy.** Development React is much slower than production React and the
overhead is uneven across component shapes, so dev-build durations rank badly
against each other and must never be quoted as the cost users pay. A plain
production build is not an option: it reports "Profiling not supported" because
production `react-dom` is compiled without the timing instrumentation.

The profiling build is **not** a prerequisite for spotting a storm. Reach for
it after the dev build has told you where to look.

```bash
PWRGIT_REACT_PROFILING=1 PWRGIT_REACT_DEVTOOLS=1 pnpm --filter @pwrgit/desktop build
pnpm --filter @pwrgit/desktop preview
```

Measured cost of the alias on the renderer bundle, `react-dom` 19.2.8:

| | baseline | profiling | delta |
|---|---|---|---|
| `assets/index-*.js` raw | 683,736 B | 703,821 B | +20,085 B (+2.9%) |
| `assets/index-*.js` gzip | 203,304 B | 209,213 B | +5,909 B (+2.9%) |
| whole `out/renderer` | 1,518,284 B | 1,538,604 B | +20,320 B (+1.3%) |

Only `react-dom/client` is aliased. Bare `react-dom` (`createPortal`,
`flushSync` — 5 renderer files) and `react-dom/server` (8 files) keep resolving
normally, and that is what keeps one reconciler in the bundle: in React 19 both
`react-dom/client` and `react-dom/profiling` require the shared bare `react-dom`
module for their internals, so swapping the client entry alone cannot produce
two copies. Reconciler-body markers confirm it — `onRecoverableError` 6/6,
`suppressHydrationWarning` 4/4, `dangerouslySetInnerHTML` 12/12 across the two
bundles; only the entry re-exports move. Confirm a build really is the profiling
one by grepping the chunk for a Profiler-only fiber field: `treeBaseDuration`
appears 21 times in the profiling bundle and 0 times in the baseline.

### The DevTools browser extension does not work here

`electron-devtools-installer` plus the React DevTools MV3 extension is a dead
end on Electron 41, and the half that works makes it look like it might.
Measured on Electron 41.10.7 with React Developer Tools 8.0.0:

- The extension installs and Electron accepts `manifest_version: 3`.
- Its background **service worker runs**.
- Content-script injection works — `__REACT_DEVTOOLS_GLOBAL_HOOK__` is
  installed in the page with the full hook API. The old `chrome.scripting`
  blocker from 2023 is genuinely gone.
- **The extension's `devtools_page` never loads.** No webContents is created
  for it, and no Components or Profiler tab appears in Electron's DevTools,
  with the window shown or hidden.

So the backend half attaches and the frontend half does not, which yields a
hook and no UI. Use the standalone route.

### Packaging cannot ship the bridge

`PWRGIT_REACT_DEVTOOLS` is read at build time, so nothing at app runtime
can undo a renderer HTML that was built with it.
[`verify-asar-contents.mjs`](scripts/verify-asar-contents.mjs) fails packaging
when any packaged HTML loads a remote script, and `release.mjs` runs it on
every packaging path. The rule is written against the shape — a remote
`<script src>` in a shipped renderer — not against the flag.

The matching lives in [`packaged-html-rules.mjs`](scripts/packaged-html-rules.mjs),
its own module because the verifier is a top-level script that calls
`process.exit` and so cannot be imported by a test. Two deliberate choices
there:

- **The scan is scoped to `/out/`.** electron-builder ships `out/**` plus the
  auto-included production `node_modules`; a dependency that vendors a demo page
  pointing at a CDN would otherwise fail a release with a message telling the
  operator to unset a flag that has nothing to do with the file.
- **An entry that cannot be read fails the gate** rather than being skipped.
  This is a check whose whole job is to stop something shipping, so "could not
  look" has to be as loud as "looked and found it".

## Runtime facts

- IPC goes through the typed command bus (`command-bus.ts` / `ipc.ts`);
  handlers return `Result`, never throw across the boundary.
- Migrations are `.sql` files copied beside the bundle by `electron.vite.config.ts`.
- git runs through the injected `GitExec` (dugite in prod; system git in tests).
- The app log is `app.getPath("logs")/main.log` — `~/Library/Logs/PwrGit` on
  macOS, `<userData>/logs` elsewhere — buffered in `src/main/logs.ts` and shown
  by Help › Logs. `src/main/process-ids.ts` puts the main, GPU, renderer and
  utility pids in that log so a pasted log names its own processes.
- `src/main/log-console.ts` mirrors `logMain` entries through `electron-log`
  (the same framework as PwrSnap/PwrAgnt). Info and above go to the terminal;
  debug stays in the file and Logs window. Initialize it before startup work.
  Its file/IPC transports are disabled because `logs.ts` owns those outputs.

## macOS release architectures

DMG and ZIP targets build universal and arm64. Keep `concurrency.jobs: 1`:
`beforePack` mutates the shared stage's Git and SQLite files per architecture.
`release.mjs` verifies both app trees, then `mac-release-artifacts.mjs` writes
one `latest-mac.yml` and stable DMG aliases. Universal must remain the legacy
`path`/`sha512` fallback and the `PwrGit.dmg` alias. Keep `arm64` in arm64 asset
names; electron-updater uses that substring to select architecture.

**Any script a signing-stage script imports must be added to both
signing-input archives** — the `tar` file list in `.github/workflows/release.yml`
and `$files` in `scripts/release/archive-windows-signing-input.ps1`. The sign
jobs run from a self-contained tarball, not a checkout, so a sibling
`import "./x.mjs"` that is not listed fails with `ERR_MODULE_NOT_FOUND` at
release time — and no PR ever catches it, because the packaging lanes skip on
pull requests. `mac-release-artifacts.mjs`, `stage-better-sqlite3-arch.mjs` and
`packaged-html-rules.mjs` are all listed for this reason. Direct macOS publication is
blocked; use the release workflow, which uploads only after validation.

## Windows installer names

`windows-release-artifacts.mjs` owns two things: the `SHA256SUMS` manifest
(written during packaging, parsed again later — keep both halves in that one
file) and the stable `PwrGit.Setup.exe` alias beside the versioned installer.
`release.mjs` imports it, so it belongs in **both** signing-input archives, the
same rule the macOS helper above follows.

The alias is cut by `release.yml`'s `windows-sign` job *after* Authenticode
verification, never during packaging: it is a byte-for-byte copy and would
otherwise inherit an unsigned intermediate. That step also asserts the file
exists, because a script that no-ops still exits 0 and `upload-artifact` only
warns when one of several globs matches nothing. Never rename the versioned
installer away — `latest.yml` names it and electron-updater fetches it by name.

The alias carries no space because GitHub Releases rewrites spaces in an asset
filename to periods and a rename cannot undo it, so the build output would
otherwise disagree with the published asset. A Windows ARM build takes
`PwrGit.Setup.Arm.exe`; this deliberately does not match `PwrGit-arm64.dmg`,
whose URL is already published. Aliases stay out of `SHA256SUMS` — same bytes,
second name. `.github/workflows/README.md` carries the operator-facing version.
