/**
 * The one promise-wrapped `setTimeout` for the main process.
 *
 * Six call sites had grown their own — the GitHub and GitLab retry backoffs,
 * the GitLab fork-import poll, the updater's dev walkthrough, the worktree
 * remove retry, and the quit drain's timeout — and the named ones had already
 * drifted apart: only one honored an AbortSignal, only one unref'd its timer.
 * That is the cost this file exists to stop paying, since a fix to any of
 * those properties otherwise has to be found and repeated six times. The
 * options here are the union of what those callers needed.
 */

export type DelayOptions = {
  /** Reject as soon as this aborts, instead of waiting the delay out. Used by
   *  polls the user can cancel — a fork import, say — so cancelling doesn't
   *  wait for the current sleep to expire first.
   *
   *  The rejection is the signal's own `reason`, so **whoever aborts owns the
   *  message the user reads**: `controller.abort({ code: "aborted", message:
   *  "Clone canceled." })`, the way `clone-handlers.ts` does. A bare `abort()`
   *  is not a blank the caller can fill in here — the platform stamps its own
   *  `AbortError` ("This operation was aborted") as the reason, which is why
   *  the per-call fallback message this used to take was dead on arrival.
   *
   *  Explicitly `| undefined`: callers thread an optional signal straight down
   *  from their own parameter, and under `exactOptionalPropertyTypes` a bare
   *  `signal?:` would make each of them branch around passing it. */
  signal?: AbortSignal | undefined;
  /** Keep a pending sleep from holding the process open. For a delay nothing
   *  is waiting on — an animation step, a best-effort backoff — rather than
   *  one whose completion the caller needs. */
  unref?: boolean;
};

/** Resolve after `ms`. With `signal`, reject on abort instead. */
export function delay(ms: number, options: DelayOptions = {}): Promise<void> {
  const { signal, unref } = options;
  return new Promise((resolve, reject) => {
    // Defensive only — a signal that reports `aborted` always carries a
    // `reason`, and rejecting with `undefined` would be worse than useless.
    const canceled = (): unknown =>
      signal?.reason ?? new Error("The operation was canceled.");
    // An already-aborted signal must not schedule a timer it would then have
    // to tear down — and must not resolve, which would let a canceled poll
    // take one more turn.
    if (signal?.aborted === true) {
      reject(canceled());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(canceled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (unref === true) timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Ceiling for a computed retry backoff. A server's `Retry-After` or
 *  rate-limit reset can be arbitrarily far out (or, with a skewed clock,
 *  negative); neither should strand a refresh. */
export const RETRY_DELAY_CEILING_MS = 60_000;

export function clampRetryDelayMs(ms: number): number {
  return Math.max(0, Math.min(ms, RETRY_DELAY_CEILING_MS));
}
