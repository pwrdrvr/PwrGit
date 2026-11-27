# Main-process quit sequencing

This guide covers how a deferred quit must resume, how OS shutdown hurries the drain, and how the quit path is tested.

Code paths in backticks are relative to [apps/desktop/src/main](../../../apps/desktop/src/main/).

## A deferred quit resumes from a macrotask

A `before-quit` or `will-quit` listener that calls `preventDefault()` and then
retries `app.quit()` must retry through `retryQuitAfterDispatch`
(`quit-retry.ts`), never straight from the promise chain it waited on. A
native quit (⌘Q, Dock → Quit, SIGTERM) runs that chain's microtasks *inside*
the Electron pass being deferred, and the pass then cancels the retry:
Electron emits `window-all-closed` where `will-quit` belongs, and only the
exit fail-safe ends the process. `quitDrain` (`bounded-shutdown.ts`) is the
one listener that defers today, and only while it has something to flush (a
profiler recording).

An OS shutdown exits after `SYSTEM_SHUTDOWN_EXIT_MS` (3 s), so it calls
`quitDrain.hurry()` first: a flush still running at the exit would skip
`will-quit` and `quit`. Any new quit path with its own exit deadline needs
the same.

Playwright quits from JavaScript, which never nests, so E2E cannot catch a
regression. `quit-reentry.test.ts` drives the drain through a model of
Electron's quit state machine (`test-support/electron-quit-model.ts`), and
`quit-drain.property.test.ts` runs random quit sessions (⌘Q, Dock, SIGTERM,
OS shutdown, update install, any flush timing) through the same model. Two
probes check the real thing without drawing anything on screen:
`pnpm --filter @pwrgit/desktop probe:quit-reentry` (re-run on an Electron
major bump; it fails if Electron stops matching the model) and, after a
build, `probe:app-quit` (the built app, quit with SIGTERM).
