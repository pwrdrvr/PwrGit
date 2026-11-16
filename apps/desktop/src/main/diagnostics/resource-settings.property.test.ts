import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_DEFAULTS } from "@pwrgit/shared";
import { DiagnosticsManager } from "./diagnostics-manager";
import { watchResourceUsage } from "./resource-monitor";

const mocks = vi.hoisted(() => ({ stop: vi.fn(async () => undefined) }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./resource-monitor", () => ({ watchResourceUsage: vi.fn(() => mocks.stop) }));

describe("resource diagnostics settings lifecycle", () => {
  it("is off on a fresh install and starts/stops exactly on setting transitions", async () => {
    expect(DIAGNOSTICS_DEFAULTS.resourceUsageEnabled).toBe(false);
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 30 }), async (changes) => {
      vi.mocked(watchResourceUsage).mockClear();
      mocks.stop.mockClear();
      const settings = { ...DIAGNOSTICS_DEFAULTS };
      const manager = new DiagnosticsManager({
        outputRoot: "/contrived/diagnostics", getDiagnostics: () => settings,
        onHotCpuHeapSnapshotLimitReached: () => undefined
      });
      await manager.sync();
      expect(watchResourceUsage).not.toHaveBeenCalled();
      expect(manager.hasPendingWork()).toBe(false);
      let running = false;
      let starts = 0;
      let stops = 0;
      try {
        for (const enabled of changes) {
          settings.resourceUsageEnabled = enabled;
          if (enabled && !running) starts++;
          if (!enabled && running) stops++;
          running = enabled;
          await manager.sync();
          expect(watchResourceUsage).toHaveBeenCalledTimes(starts);
          expect(mocks.stop).toHaveBeenCalledTimes(stops);
          expect(manager.hasPendingWork()).toBe(running);
        }
      } finally {
        if (running) stops++;
        await manager.shutdown();
      }
      expect(mocks.stop).toHaveBeenCalledTimes(stops);
      expect(manager.hasPendingWork()).toBe(false);
    }));
  });
});
