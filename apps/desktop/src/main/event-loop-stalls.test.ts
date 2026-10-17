import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchEventLoopStalls, type EventLoopStallMonitor } from "./event-loop-stalls";

const logMainMock = vi.fn();

vi.mock("./logs", () => ({
  logMain: (...args: unknown[]) => logMainMock(...args)
}));

const INTERVAL_MS = 500;

/** The message argument of every logMain call, in order. */
function loggedLines(): string[] {
  return logMainMock.mock.calls.map((call) => String(call[2]));
}

// Fake timers fire the heartbeat; `setSystemTime` moves the clock without
// firing anything, which is exactly what a blocked main thread looks like from
// the inside — time passes and no callback gets to run.
function block(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe("watchEventLoopStalls", () => {
  let monitor: EventLoopStallMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    logMainMock.mockReset();
    monitor = watchEventLoopStalls({
      thresholdMs: 2_000,
      intervalMs: INTERVAL_MS,
      minReportGapMs: 60_000,
      now: () => Date.now()
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("says nothing while the loop keeps up", () => {
    vi.advanceTimersByTime(30_000);
    expect(logMainMock).not.toHaveBeenCalled();
  });

  it("logs one warning per stall with the measured duration", () => {
    vi.advanceTimersByTime(INTERVAL_MS);
    block(34_000);
    vi.advanceTimersByTime(INTERVAL_MS);
    vi.advanceTimersByTime(10_000);

    expect(logMainMock).toHaveBeenCalledTimes(1);
    expect(logMainMock).toHaveBeenCalledWith(
      "warn",
      "process",
      "main event loop blocked for 34000ms (threshold 2000ms)"
    );
  });

  it("ignores a hitch under the threshold", () => {
    vi.advanceTimersByTime(INTERVAL_MS);
    block(1_999);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(logMainMock).not.toHaveBeenCalled();
  });

  it("folds repeated stalls inside the report gap into one summary", () => {
    vi.advanceTimersByTime(INTERVAL_MS);
    block(3_000);
    vi.advanceTimersByTime(INTERVAL_MS);
    for (const ms of [5_000, 4_000, 7_000]) {
      vi.advanceTimersByTime(5_000);
      block(ms);
      vi.advanceTimersByTime(INTERVAL_MS);
    }
    expect(loggedLines()).toEqual([
      "main event loop blocked for 3000ms (threshold 2000ms)"
    ]);

    // The summary waits for the gap to elapse, then goes out on its own tick.
    vi.advanceTimersByTime(60_000);
    expect(loggedLines()).toEqual([
      "main event loop blocked for 3000ms (threshold 2000ms)",
      "main event loop blocked 3 more time(s) in the last 60s; longest 7000ms"
    ]);

    // After the summary, the next stall is reported on its own again.
    vi.advanceTimersByTime(60_000);
    block(2_500);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(loggedLines().at(-1)).toBe(
      "main event loop blocked for 2500ms (threshold 2000ms)"
    );
    expect(logMainMock).toHaveBeenCalledTimes(3);
  });

  it("does not count system sleep as a stall", () => {
    vi.advanceTimersByTime(INTERVAL_MS);
    monitor.pause();
    block(8 * 60 * 60 * 1000);
    vi.advanceTimersByTime(INTERVAL_MS);
    monitor.resume();
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(logMainMock).not.toHaveBeenCalled();
  });

  it("stops ticking once stopped", () => {
    monitor.stop();
    block(10_000);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(logMainMock).not.toHaveBeenCalled();
  });
});
