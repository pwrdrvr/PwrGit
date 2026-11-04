import { performance } from "node:perf_hooks";
import { logMain } from "./logs";

// A synchronous call on the main thread freezes every window (the macOS
// beachball) and leaves no trace in the log: the only evidence is a gap between
// two timestamps, which reads the same as an idle app. A heartbeat that notices
// it ran late turns that gap into a line that says main was blocked, and for how
// long, stamped at the moment main got the thread back — right after whatever
// was logged by the work that blocked it.

/** Shorter hitches are GC pauses and big IPC payloads, not something to chase. */
const DEFAULT_THRESHOLD_MS = 2_000;
/** Coarse enough to cost nothing, fine enough that the reported duration is close. */
const DEFAULT_INTERVAL_MS = 500;
// A pathological loop that stalls every few seconds would otherwise write a
// line per stall for as long as it lasts, and the 2 MiB log would rotate away
// the history that explains how it started. One line per window, with the rest
// folded into a summary, keeps the first report and still says it kept going.
const DEFAULT_MIN_REPORT_GAP_MS = 60_000;

export type EventLoopStallOptions = {
  thresholdMs?: number;
  intervalMs?: number;
  minReportGapMs?: number;
  /** Monotonic: wall-clock time jumps with NTP and manual clock changes. */
  now?: () => number;
  /** Runs `tick` every `intervalMs` without keeping the process alive; returns a cancel. */
  every?: (tick: () => void, intervalMs: number) => () => void;
};

export type EventLoopStallMonitor = {
  /** Stop measuring until `resume` — for system sleep, which is not a stall. */
  pause(): void;
  resume(): void;
  stop(): void;
};

function unrefInterval(tick: () => void, intervalMs: number): () => void {
  const handle = setInterval(tick, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}

/** Start the heartbeat. Called once from index.ts after the log file is ready. */
export function watchEventLoopStalls(
  options: EventLoopStallOptions = {}
): EventLoopStallMonitor {
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const minReportGapMs = options.minReportGapMs ?? DEFAULT_MIN_REPORT_GAP_MS;
  const now = options.now ?? (() => performance.now());
  const every = options.every ?? unrefInterval;

  let lastTick = now();
  let paused = false;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  let suppressedLongestMs = 0;

  const flushSuppressed = (at: number): void => {
    if (suppressed === 0 || at - lastReportAt < minReportGapMs) return;
    logMain(
      "warn",
      "process",
      `main event loop blocked ${suppressed} more time(s) in the last ` +
        `${Math.round((at - lastReportAt) / 1000)}s; longest ${suppressedLongestMs}ms`
    );
    lastReportAt = at;
    suppressed = 0;
    suppressedLongestMs = 0;
  };

  const tick = (): void => {
    const at = now();
    // A timer that fires late was late because nothing else could run: the
    // lateness, not the gap between ticks, is how long main was held.
    const blockedMs = Math.round(at - lastTick - intervalMs);
    lastTick = at;
    if (paused) return;

    if (blockedMs < thresholdMs) {
      flushSuppressed(at);
      return;
    }
    if (at - lastReportAt < minReportGapMs) {
      suppressed += 1;
      suppressedLongestMs = Math.max(suppressedLongestMs, blockedMs);
      return;
    }
    flushSuppressed(at);
    logMain(
      "warn",
      "process",
      `main event loop blocked for ${blockedMs}ms (threshold ${thresholdMs}ms)`
    );
    lastReportAt = at;
  };

  const cancel = every(tick, intervalMs);

  return {
    pause() {
      paused = true;
    },
    resume() {
      // The first tick after wake measures the whole sleep; start it fresh.
      lastTick = now();
      paused = false;
    },
    stop: cancel
  };
}
