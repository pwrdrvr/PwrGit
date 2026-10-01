import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuitDrain, drainBeforeQuit } from "./bounded-shutdown";

describe("bounded quit drain", () => {
  it("waits for diagnostics and agent cleanup", async () => {
    let finishDiagnostics = (): void => undefined;
    let finishAgent = (): void => undefined;
    const diagnostics = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDiagnostics = resolve;
        })
    );
    const agent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAgent = resolve;
        })
    );

    let drained = false;
    const pending = drainBeforeQuit([diagnostics, agent], 10_000).then(() => {
      drained = true;
    });
    await vi.waitFor(() => {
      expect(diagnostics).toHaveBeenCalledOnce();
      expect(agent).toHaveBeenCalledOnce();
    });

    finishDiagnostics();
    await Promise.resolve();
    expect(drained).toBe(false);
    finishAgent();
    await pending;
    expect(drained).toBe(true);
  });

  it("returns at the deadline when a cleanup task hangs", async () => {
    vi.useFakeTimers();
    try {
      const pending = drainBeforeQuit(
        [() => new Promise<void>(() => undefined)],
        1_500
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("quit diagnostics barrier", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Run the setImmediate the resume hops through (fake timers fire it 1 ms on). */
  const afterResumeHop = () => vi.advanceTimersByTimeAsync(1);

  function setup() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const stopping = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const stop = vi.fn(() => stopping);
    const resumeQuit = vi.fn();
    const warn = vi.fn();
    const drain = createQuitDrain({ stop, resumeQuit, warn });
    const event = { preventDefault: vi.fn() };
    return { drain, stop, resumeQuit, warn, event, resolve, reject };
  }

  it("waits for completion, clears the deadline, and passes reentrant quit", async () => {
    const s = setup();
    s.resumeQuit.mockImplementation(() => {
      expect(s.drain.beforeQuit(s.event)).toBe(false);
    });
    expect(s.drain.beforeQuit(s.event)).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.resumeQuit).not.toHaveBeenCalled();
    s.resolve();
    await afterResumeHop();
    expect(s.resumeQuit).toHaveBeenCalledOnce();
    expect(s.event.preventDefault).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it("keeps one deadline across repeated quits and releases a hung stop at 10s", async () => {
    const s = setup();
    s.drain.beforeQuit(s.event);
    await vi.advanceTimersByTimeAsync(9_999);
    s.drain.beforeQuit(s.event);
    expect(s.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(s.resumeQuit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await afterResumeHop();
    expect(s.resumeQuit).toHaveBeenCalledOnce();
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining("10000 ms"), undefined);
    expect(s.drain.beforeQuit(s.event)).toBe(false);
    expect(s.event.preventDefault).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)("ignores late %s after timeout", async (settle) => {
    const s = setup();
    s.drain.beforeQuit(s.event);
    await vi.advanceTimersByTimeAsync(10_000);
    if (settle === "resolve") s.resolve();
    else s.reject(new Error("late failure"));
    await afterResumeHop();
    expect(s.resumeQuit).toHaveBeenCalledOnce();
    expect(s.warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject"])("releases quit on stop %s even if logging fails", async (mode) => {
    const error = new Error("stop failed");
    const resumeQuit = vi.fn();
    const warn = vi.fn(() => { throw new Error("logger failed"); });
    const drain = createQuitDrain({
      stop: () => {
        if (mode === "throw") throw error;
        return Promise.reject(error);
      },
      resumeQuit,
      warn
    });
    drain.beforeQuit({ preventDefault: vi.fn() });
    await afterResumeHop();
    expect(resumeQuit).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed"), error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports a synchronous stop that reenters quit", async () => {
    const resumeQuit = vi.fn();
    const event = { preventDefault: vi.fn() };
    const stop = vi.fn(() => { drain.beforeQuit(event); });
    const drain = createQuitDrain({ stop, resumeQuit, warn: vi.fn() });
    drain.beforeQuit(event);
    await afterResumeHop();
    expect(stop).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(resumeQuit).toHaveBeenCalledOnce();
  });

  it.each([false, true])("lets an update own quit (pending normal quit: %s)", async (normalQuit) => {
    const s = setup();
    if (normalQuit) s.drain.beforeQuit(s.event);
    const flush = s.drain.flushForUpdate();
    expect(s.drain.flushForUpdate()).toBe(flush);
    s.drain.beforeQuit(s.event);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    s.resolve();
    await flush;
    expect(s.drain.beforeQuit(s.event)).toBe(false);
    expect(s.resumeQuit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a hung update flush without resuming normal quit", async () => {
    const s = setup();
    s.drain.beforeQuit(s.event);
    const flush = s.drain.flushForUpdate();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush;
    await afterResumeHop();
    expect(s.resumeQuit).not.toHaveBeenCalled();
    expect(s.drain.beforeQuit(s.event)).toBe(false);
  });

  it("resumes from a later macrotask, never from the flush's own microtasks", async () => {
    // A native quit runs those microtasks inside the before-quit pass being
    // deferred, which then cancels the resumed quit (quit-reentry.test.ts).
    const s = setup();
    s.drain.beforeQuit(s.event);
    s.resolve();
    for (let i = 0; i < 100; i += 1) await Promise.resolve();
    expect(s.resumeQuit).not.toHaveBeenCalled();
    await afterResumeHop();
    expect(s.resumeQuit).toHaveBeenCalledOnce();
  });

  it("lets an update that takes over during the resume hop win", async () => {
    const s = setup();
    s.drain.beforeQuit(s.event);
    s.resolve();
    for (let i = 0; i < 100; i += 1) await Promise.resolve();
    void s.drain.flushForUpdate();
    await afterResumeHop();
    expect(s.resumeQuit).not.toHaveBeenCalled();
  });

  it("does not defer a quit when nothing is pending, but still stops", async () => {
    const stop = vi.fn(async () => undefined);
    const resumeQuit = vi.fn();
    const drain = createQuitDrain({
      stop,
      resumeQuit,
      warn: vi.fn(),
      hasPendingWork: () => false
    });
    const event = { preventDefault: vi.fn() };
    expect(drain.beforeQuit(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    await afterResumeHop();
    expect(stop).toHaveBeenCalledOnce();
    expect(resumeQuit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers when work is pending, and keeps an update's quit deferred regardless", async () => {
    let pending = true;
    const s = setup();
    const drain = createQuitDrain({
      stop: s.stop,
      resumeQuit: s.resumeQuit,
      warn: s.warn,
      hasPendingWork: () => pending
    });
    expect(drain.beforeQuit(s.event)).toBe(true);
    // Once a quit is deferred, every later pass waits for the same flush.
    pending = false;
    expect(drain.beforeQuit(s.event)).toBe(true);

    const update = createQuitDrain({
      stop: s.stop,
      resumeQuit: vi.fn(),
      warn: vi.fn(),
      hasPendingWork: () => false
    });
    void update.flushForUpdate();
    expect(update.beforeQuit(s.event)).toBe(true);
  });

  it("runs the agent's existing deadline alongside diagnostics", async () => {
    let finishDiagnostics!: () => void;
    const diagnostics = vi.fn(() => new Promise<void>((resolve) => { finishDiagnostics = resolve; }));
    const agent = vi.fn(() => new Promise<void>(() => {}));
    const resumeQuit = vi.fn();
    const drain = createQuitDrain({
      stop: async () => {
        await Promise.allSettled([diagnostics(), drainBeforeQuit([agent], 1_500)]);
      },
      resumeQuit,
      warn: vi.fn()
    });
    drain.beforeQuit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent).toHaveBeenCalledOnce();
    expect(resumeQuit).not.toHaveBeenCalled();
    finishDiagnostics();
    await afterResumeHop();
    expect(resumeQuit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
