import { retryQuitAfterDispatch } from "./quit-retry";

/**
 * Await every shutdown task, but never hold Electron open past the fail-safe.
 * Tasks are started independently so one synchronous failure cannot prevent
 * another subsystem from beginning its cleanup.
 */
export async function drainBeforeQuit(
  tasks: readonly (() => Promise<unknown>)[],
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  const shutdowns = Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(task))
  ).then(() => undefined);

  try {
    await Promise.race([shutdowns, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** One diagnostics deadline shared by normal quit and explicit update installs. */
export function createQuitDrain(options: {
  stop: () => void | Promise<void>;
  resumeQuit: () => void;
  warn: (message: string, error?: unknown) => void;
  /**
   * Whether anything is recording or running that `stop` would have to wait
   * for. When this says no, quit is not deferred at all: `stop` still runs
   * (it latches each subsystem's shutting-down state) but nothing waits on
   * it, so the common quit is one before-quit pass, as Electron intends.
   * Omitted means always defer.
   */
  hasPendingWork?: () => boolean;
}) {
  let complete = false;
  let resumingQuit = false;
  let updaterOwnsQuit = false;
  let pending: Promise<void> | undefined;

  const flush = (): Promise<void> => {
    pending ??= new Promise<void>((resolve) => {
      const finish = (warning?: string, error?: unknown): void => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        try {
          if (warning) options.warn(warning, error);
        } catch {
          // A failed logger must not keep a prevented quit open.
        }
        resolve();
      };
      // Referenced so shutdown still resumes with no windows/other handles.
      // This bounds async hangs; a blocked JS event loop cannot run the timer.
      const timer = setTimeout(
        () => finish("diagnostics shutdown exceeded 10000 ms; continuing quit"),
        10_000
      );
      void Promise.resolve().then(options.stop).then(
        () => finish(),
        (error: unknown) => finish("diagnostics shutdown failed; continuing quit", error)
      );
    });
    return pending;
  };

  return {
    flushForUpdate(): Promise<void> {
      // An install can take over an already pending normal quit. Never issue
      // app.quit (or its exit fail-safe) ahead of the updater's transition.
      updaterOwnsQuit = true;
      return flush();
    },
    beforeQuit(event: { preventDefault(): void }): boolean {
      if (complete) return false;
      if (!resumingQuit && !updaterOwnsQuit && options.hasPendingWork?.() === false) {
        void flush();
        return false;
      }
      event.preventDefault();
      if (!resumingQuit) {
        resumingQuit = true;
        // Never resume from this chain directly. With nothing slow to flush
        // it settles in microtasks, and a native quit (⌘Q, Dock, SIGTERM)
        // runs those INSIDE the before-quit pass being deferred, which then
        // cancels the resumed quit. See quit-retry.ts. An update that takes
        // over decides at settle time, and one that takes over during the
        // hop still wins.
        void flush().then(() => {
          if (updaterOwnsQuit) return;
          retryQuitAfterDispatch(() => {
            if (!updaterOwnsQuit) options.resumeQuit();
          });
        });
      }
      return true;
    }
  };
}
