# Desktop runtime and diagnostics

This guide covers E2E builds, React DevTools profiling, and the main-process runtime facts: IPC, migrations, git execution and logging.

## e2e needs a build first

Full-app E2E opens real desktop windows, including without `--headed`. Run it
through Control MCP on the dedicated lab VM; read
[the lab procedure](../../headed-e2e-pwrsuitelab.md) first. The guest's
`test:e2e` pretest builds `out/main/index.js`. A direct Playwright invocation
needs that build in the guest first. Hidden harnesses need no app build.

## Profiling the renderer with React DevTools

Before you profile, read
[docs/react-devtools-profiling.md](../../react-devtools-profiling.md).
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
  - For 12-hour CPU/energy investigations, read [docs/resource-usage.md](../../resource-usage.md): opt-in Troubleshooting recording writes minute samples under `diagnostics/resources/`, separating Electron CPU from Git counts and lifetimes.
- `logMain` uses scoped `electron-log` loggers (as in PwrSnap/PwrAgnt):
  console, file, 2 MiB rotation (`main.old.log`), and a file hook to the Logs
  window. Info+ goes to the terminal; debug only to file and Logs window. `log-console.ts` guards closed stdio pipes. Await
  `initLogFile` before startup logging; it keeps pre-0.14 history.
