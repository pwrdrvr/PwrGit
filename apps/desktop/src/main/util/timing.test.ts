import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampRetryDelayMs, delay, RETRY_DELAY_CEILING_MS } from "./timing";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("delay", () => {
  it("resolves once the delay has run out, not before", async () => {
    let settled = false;
    const pending = delay(500).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("rejects with the abort reason instead of waiting the delay out", async () => {
    const controller = new AbortController();
    const reason = { kind: "git", code: "aborted", message: "Clone canceled." };
    const pending = delay(60_000, { signal: controller.signal });

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    // The timer is torn down with it: a canceled poll must not come back to
    // life and take another turn.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to the platform's own reason for a bare abort", async () => {
    const controller = new AbortController();
    const pending = delay(60_000, { signal: controller.signal });

    controller.abort();

    // `abort()` stamps an AbortError as the reason, so there is never a blank
    // for a caller-supplied message to fill — abort with a reason to say
    // something better than this.
    await expect(pending).rejects.toThrow("This operation was aborted");
  });

  it("refuses a signal that has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    // Scheduling here would let a caller that checked its signal a moment too
    // early still get one more turn.
    const pending = delay(60_000, { signal: controller.signal });

    await expect(pending).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops listening for an abort that can no longer matter", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const pending = delay(10, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    await pending;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("leaves the process free to exit when asked to", async () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setTimeout>);

    void delay(10, { unref: true });
    expect(unref).toHaveBeenCalledOnce();

    unref.mockClear();
    void delay(10);
    expect(unref).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });
});

describe("clampRetryDelayMs", () => {
  it("keeps a computed backoff inside the ceiling", () => {
    expect(clampRetryDelayMs(1_000)).toBe(1_000);
    // A far-future rate-limit reset must not strand a refresh for an hour.
    expect(clampRetryDelayMs(60 * 60_000)).toBe(RETRY_DELAY_CEILING_MS);
    // A skewed clock can make `reset - now` negative.
    expect(clampRetryDelayMs(-5_000)).toBe(0);
  });
});
