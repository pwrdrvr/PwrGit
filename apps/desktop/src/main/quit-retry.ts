/**
 * Re-issue a quit that a `before-quit` or `will-quit` listener deferred.
 *
 * Always from a fresh macrotask, never from the promise chain that settled
 * the deferral. Electron's quit state machine (shell/browser/browser.cc,
 * verified on 41.10.7) is:
 *
 *   Browser::Quit():              if (is_quitting_) return;
 *                                 is_quitting_ = HandleBeforeQuit();  // emits before-quit
 *   Browser::NotifyAndShutdown(): emits will-quit;
 *                                 if (prevented) is_quitting_ = false;
 *
 * and an emit that starts from a native task — ⌘Q (`terminate:` from the
 * `role: "quit"` menu item), Dock → Quit, SIGTERM, and EVERY will-quit, which
 * is emitted when the last window finishes closing — runs a microtask
 * checkpoint as the emit returns, still inside those functions. A retry that
 * settles in microtasks therefore runs nested inside the pass it retries:
 *
 * - from before-quit: the nested pass sets `is_quitting_ = true` and starts
 *   closing windows, then the outer pass returns and writes `false` over it.
 *   The last window finishes closing with Electron believing it is not
 *   quitting, so it emits `window-all-closed` instead of `will-quit`.
 * - from will-quit: the nested `Browser::Quit()` sees `is_quitting_` still
 *   true and returns at once; the outer pass then sets it false. No windows,
 *   no event, no quit.
 *
 * `scripts/electron-quit-reentry-probe.mjs` measures both on the shipped
 * Electron. A macrotask cannot run until the outer pass has returned, so the
 * retry always starts from a settled state.
 */
export function retryQuitAfterDispatch(quit: () => void): void {
  setImmediate(quit);
}

/**
 * `app.quit()`, with `app.exit(0)` behind it if Electron has not emitted
 * `quit` within `afterMs`. A safety net, not the fix: a resumed quit that
 * Electron swallows (see `retryQuitAfterDispatch`) would otherwise leave a
 * process with no windows, so the fail-safe says so in the log rather than
 * passing for a normal quit.
 */
export function quitWithExitFailSafe(
  app: {
    quit(): void;
    exit(exitCode?: number): void;
    on(event: "quit", listener: () => void): unknown;
  },
  options: { afterMs: number; warn: (message: string) => void }
): void {
  let quit = false;
  app.on("quit", () => {
    quit = true;
  });
  app.quit();
  setTimeout(() => {
    if (quit) return;
    options.warn(
      `quit had not completed ${options.afterMs} ms after resuming; exiting`
    );
    app.exit(0);
  }, options.afterMs);
}
