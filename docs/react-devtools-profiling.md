# Profiling the renderer with React DevTools

How to attach the standalone React DevTools to PwrGit and which build to
profile. The short version, and the rules that apply to every change, are in
[apps/desktop/AGENTS.md](../apps/desktop/AGENTS.md).

Nothing in the app connects React DevTools on its own. Two opt-in env vars,
both read by [`electron.vite.config.ts`](../apps/desktop/electron.vite.config.ts) at Vite
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

## Attaching to the dev build

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

## Knowing which instance you attached

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

## Which build to use for what

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

## The DevTools browser extension does not work here

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

## Packaging cannot ship the bridge

`PWRGIT_REACT_DEVTOOLS` is read at build time, so nothing at app runtime
can undo a renderer HTML that was built with it.
[`verify-asar-contents.mjs`](../apps/desktop/scripts/verify-asar-contents.mjs) fails packaging
when any packaged HTML loads a remote script, and `release.mjs` runs it on
every packaging path. The rule is written against the shape — a remote
`<script src>` in a shipped renderer — not against the flag.

The matching lives in [`packaged-html-rules.mjs`](../apps/desktop/scripts/packaged-html-rules.mjs),
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

