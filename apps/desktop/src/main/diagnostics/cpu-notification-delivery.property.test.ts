import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { DIAGNOSTICS_DEFAULTS, type HotCpuProfileCapturedEvent } from "@pwrgit/shared";
import { DiagnosticsManager } from "./diagnostics-manager";

vi.mock("electron", () => ({ app: {
  getVersion: () => "test",
  getAppMetrics: () => [process.pid, 42, 43].map((pid) => ({ pid, cpu: { percentCPUUsage: 90, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1, peakWorkingSetSize: 1 } }))
} }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

function window(id: number): BrowserWindow {
  let attached = false;
  const debuggerTarget = {
    attach: () => { attached = true; }, detach: () => { attached = false; },
    isAttached: () => attached, on: () => {}, off: () => {},
    sendCommand: async (command: string) => command === "Profiler.stop" ? { profile: {
      nodes: [{ id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 } }],
      startTime: 1, endTime: 2, samples: [1], timeDeltas: [1]
    } } : {}
  };
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id, debugger: debuggerTarget, isDestroyed: () => false, getOSProcessId: () => id } }) as unknown as BrowserWindow;
}

it("delivers every completed capture once with its producing profile, including shutdown flushes", async () => {
  vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE", "spike");
  vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_START_DELAY_MS", "0");
  vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_DURATION_MS", "60000");
  try {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 2 }), async (profiles) => {
      const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-delivery-"));
      const events: { event: HotCpuProfileCapturedEvent; profileId: string | null }[] = [];
      const manager = new DiagnosticsManager({
        outputRoot: root, getDiagnostics: () => ({ ...DIAGNOSTICS_DEFAULTS, hotCpuProfilingEnabled: true }),
        onHotCpuHeapSnapshotLimitReached: () => {},
        onHotCpuProfileCaptured: (event, profileId) => { events.push({ event, profileId }); }
      });
      try {
        manager.attachWindow(window(42), profiles[0]!);
        manager.attachWindow(window(43), profiles[1]!);
        await manager.sync();
        // Await recorded start events through real I/O, rather than guessing
        // when self-rescheduling sampling timers finish their disk writes.
        const deadline = performance.now() + 5000;
        let started = 0;
        while (started < 3 && performance.now() < deadline) {
          const directories = await readdir(root);
          const records = await Promise.all(directories.map(async (name) => readFile(join(root, name, "events.ndjson"), "utf8").catch(() => "")));
          started = records.filter((record) => record.includes('"type":"profile-started"')).length;
        }
        expect(started).toBe(3);
        await manager.shutdown(); // Flushes all three active profiles and callbacks.
        expect(events).toHaveLength(3);
        expect(events.filter(({ event }) => event.target === "main").map(({ profileId }) => profileId)).toEqual([null]);
        expect(events.filter(({ event }) => event.target === "renderer").map(({ profileId }) => profileId).sort()).toEqual([...profiles].sort());
        for (const { event } of events) {
          const manifest = JSON.parse(await readFile(join(event.sessionDirectory, "session.json"), "utf8"));
          expect(manifest.artifacts).toContain(event.profileFilename);
          expect(JSON.parse(await readFile(event.profilePath, "utf8")).nodes.length).toBeGreaterThan(0);
        }
        await manager.shutdown();
        expect(events).toHaveLength(3);
      } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
    }), { numRuns: 3 });
  } finally { vi.unstubAllEnvs(); }
});
