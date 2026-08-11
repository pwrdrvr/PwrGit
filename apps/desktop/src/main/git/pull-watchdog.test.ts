import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullWatchdog } from "./pull-watchdog";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PullWatchdog", () => {
  it("warns periodically, resets on output, and aborts a stalled phase", () => {
    const warnings: unknown[] = [];
    const timeouts: unknown[] = [];
    const watchdog = new PullWatchdog({
      stallWarningMs: 100,
      stallTimeoutMs: 300,
      operationTimeoutMs: 1_000,
      onStallWarning: (snapshot) => warnings.push(snapshot),
      onTimeout: (error, snapshot) => timeouts.push({ error, snapshot })
    });
    watchdog.setPhase("fast_forward");

    vi.advanceTimersByTime(100);
    expect(warnings).toEqual([
      { phase: "fast_forward", elapsedMs: 100, idleMs: 100 }
    ]);

    vi.advanceTimersByTime(50);
    watchdog.noteActivity();
    vi.advanceTimersByTime(99);
    expect(warnings).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(warnings).toHaveLength(2);

    vi.advanceTimersByTime(200);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toMatchObject({
      kind: "remote",
      code: "pull_stalled"
    });
    expect(timeouts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the absolute limit despite continuing command output", () => {
    const watchdog = new PullWatchdog({
      stallWarningMs: 100,
      stallTimeoutMs: 200,
      operationTimeoutMs: 450
    });
    watchdog.setPhase("fetch");

    for (let elapsed = 0; elapsed < 400; elapsed += 50) {
      vi.advanceTimersByTime(50);
      watchdog.noteActivity();
    }
    vi.advanceTimersByTime(50);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toMatchObject({
      kind: "remote",
      code: "pull_timed_out"
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears every timer after a successful pull", () => {
    const warning = vi.fn();
    const watchdog = new PullWatchdog({
      stallWarningMs: 100,
      stallTimeoutMs: 300,
      operationTimeoutMs: 1_000,
      onStallWarning: warning
    });
    watchdog.setPhase("reapply");
    watchdog.finish();

    vi.runAllTimers();
    expect(warning).not.toHaveBeenCalled();
    expect(watchdog.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
