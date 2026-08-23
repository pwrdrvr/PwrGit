import { describe, expect, it, vi } from "vitest";
import { drainBeforeQuit } from "./bounded-shutdown";

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
