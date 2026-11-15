import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPullWatchdogDeadlines, PullWatchdog } from "./pull-watchdog";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("pull watchdog wall-clock deadline property", () => {
  it("expires overdue live commands immediately on resume without waiting for output or timers", () => {
    vi.setSystemTime(0);
    const active = new PullWatchdog();
    const finished = new PullWatchdog();
    finished.finish();
    vi.setSystemTime(2 * 60 * 60_000);
    checkPullWatchdogDeadlines();
    expect(active.signal.reason).toMatchObject({ code: "pull_timed_out" });
    expect(finished.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revive a silent command when output arrives after a long sleep", () => {
    vi.setSystemTime(0);
    const watchdog = new PullWatchdog({ stallTimeoutMs: 100, operationTimeoutMs: 400 });
    vi.setSystemTime(100);
    watchdog.noteActivity();
    expect(watchdog.signal.reason).toMatchObject({ code: "pull_stalled" });
    expect(vi.getTimerCount()).toBe(0);
  });
  // Moving the wall clock without dispatching timers models sleep on systems
  // whose timer clock pauses. Output after wake must not revive an expired run.
  it("cannot erase a missed idle or absolute deadline with output after sleep", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 80 }), fc.integer({ min: 1, max: 500 }), (beforeSleep, asleep) => {
      vi.setSystemTime(0);
      const watchdog = new PullWatchdog({ stallWarningMs: 50, stallTimeoutMs: 100, operationTimeoutMs: 400 });
      try {
        vi.setSystemTime(beforeSleep);
        watchdog.noteActivity();
        vi.setSystemTime(beforeSleep + asleep);
        watchdog.noteActivity();
        const expected = beforeSleep + asleep >= 400 ? "pull_timed_out" : asleep >= 100 ? "pull_stalled" : null;
        expect(watchdog.signal.aborted).toBe(expected !== null);
        if (expected !== null) expect(watchdog.signal.reason.code).toBe(expected);
      } finally {
        watchdog.finish();
      }
      expect(vi.getTimerCount()).toBe(0);
    }));
  });
});
