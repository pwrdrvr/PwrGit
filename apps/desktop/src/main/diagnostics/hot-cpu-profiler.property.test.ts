import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profiler } from "node:inspector";
import type { BrowserWindow, ProcessMetric } from "electron";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_DEFAULTS } from "@pwrgit/shared";
import { DiagnosticsManager } from "./diagnostics-manager";
import { HotCpuProfiler } from "./hot-cpu-profiler";
import { createHotCpuProfileSession } from "./hot-cpu-profile-session";
import { resolveHotCpuProfileConfig } from "./hot-cpu-profile-config";

vi.mock("electron", () => ({ app: { getVersion: () => "test", getAppMetrics: () => [] } }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const versions = { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version };

// An independent recorder oracle: work appears in a profile only if the
// debugger was actually recording when that work happened.
function recorder() {
  let attached = false;
  let recording = false;
  let startTime = 0;
  let marks: { name: string; at: number }[] = [];
  const commands: string[] = [];
  return {
    commands,
    mark(name: string) {
      if (recording) marks.push({ name, at: performance.now() * 1000 });
    },
    debugger: {
      attach: () => { attached = true; },
      detach: () => { attached = false; recording = false; },
      isAttached: () => attached,
      on: () => {}, off: () => {},
      sendCommand: async (method: string) => {
        commands.push(method);
        if (method === "Profiler.start") {
          recording = true; startTime = performance.now() * 1000; marks = [];
        }
        if (method !== "Profiler.stop") return {};
        recording = false;
        const profile: Profiler.Profile = {
          startTime, endTime: performance.now() * 1000,
          nodes: [{ id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: marks.map((_, i) => i + 2) },
            ...marks.map((mark, i) => ({ id: i + 2, callFrame: { functionName: mark.name, scriptId: "1", url: "work.js", lineNumber: i, columnNumber: 0 } }))],
          samples: marks.map((_, i) => i + 2),
          timeDeltas: marks.map((mark, i) => mark.at - (marks[i - 1]?.at ?? startTime))
        };
        return { profile };
      }
    }
  };
}

function config(root: string) {
  const config = resolveHotCpuProfileConfig({ enabled: true, outputRoot: root, triggerMode: "spike", env: {} });
  if (!config.enabled) throw new Error("enabled");
  return { ...config, intervalMs: 100, profileDurationMs: 500, maxProfiles: 1 };
}

async function session(root: string) {
  const result = await createHotCpuProfileSession({ config: config(root), versions });
  if (!result.ok) throw new Error(result.message);
  return result.session;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("hot CPU recorder invariants", () => {
  it("retains work from the hot interval before its sampling trigger, including across rotations", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 10, max: 90 }), fc.integer({ min: 0, max: 3 }), async (offset, rotations) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-history-"));
      const events: { type: string; detail?: Record<string, unknown> }[] = [];
      const capture = { ...await session(root), appendEvent: async (event: { type: string; detail?: Record<string, unknown> }) => { events.push(event); }, appendSample: async () => {} };
      const target = recorder();
      let cpu = 0;
      const profiler = new HotCpuProfiler({
        config: config(root), session: capture, logger,
        target: { debugger: target.debugger, getOSProcessId: () => 42 },
        getAppMetrics: () => [{ pid: 42, cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1, peakWorkingSetSize: 1 } }] as ProcessMetric[]
      });
      try {
        await profiler.start();
        await vi.advanceTimersByTimeAsync(0);
        // Mark immediately before a rotation, then trigger immediately after.
        const before = rotations ? rotations * 30_000 - 100 + offset : offset;
        await vi.advanceTimersByTimeAsync(before);
        target.mark("beforeTriggerWork");
        await vi.advanceTimersByTimeAsync(100 - offset);
        target.mark("atRotationBoundary");
        cpu = 80;
        await vi.advanceTimersByTimeAsync(100);
        await profiler.stop("config-changed");
        const profile: Profiler.Profile = JSON.parse(await readFile(capture.createProfilePath(1), "utf8"));
        const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
        expect(profile.samples!.map((id) => frames.get(id))).toContain("beforeTriggerWork");
        expect(profile.samples!.map((id) => frames.get(id))).toContain("atRotationBoundary");
        expect(profile.timeDeltas!.every((delta) => delta >= 0)).toBe(true);
        expect(profile.endTime - profile.startTime).toBeLessThanOrEqual(60_600_000);
        expect(profile.nodes.filter((node) => node.callFrame.functionName === "(root)")).toHaveLength(1);
        expect(new Set(profile.nodes.map((node) => node.id)).size).toBe(profile.nodes.length);

        expect(events.find((event) => event.type === "profile-started")?.detail?.preTriggerDurationMs).toBeGreaterThanOrEqual(100);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await profiler.stop();
        vi.useRealTimers();
        await rm(root, { recursive: true, force: true });
      }
    }), { numRuns: 12 });
  });

  it("keeps exactly one main-process session through arbitrary window ownership changes", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async (operations) => {
      const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-main-"));
      let enabled = true;
      const manager = new DiagnosticsManager({ outputRoot: root, getDiagnostics: () => ({ ...DIAGNOSTICS_DEFAULTS, hotCpuProfilingEnabled: enabled }), onHotCpuHeapSnapshotLimitReached: () => {} });
      const windows: EventEmitter[] = [];
      try {
        await manager.sync();
        for (const open of [true, true, ...operations]) {
          if (open || windows.length === 0) {
            const id = windows.length + 1;
            const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id, debugger: recorder().debugger, isDestroyed: () => false, getOSProcessId: () => id + 100, takeHeapSnapshot: async () => {} } });
            manager.attachWindow(window as unknown as BrowserWindow);
            windows.push(window);
          } else windows.pop()!.emit("closed");
          await manager.sync();
          const manifests = await Promise.all((await readdir(root)).map(async (name) => JSON.parse(await readFile(join(root, name, "session.json"), "utf8"))));
          expect(manifests.filter((manifest) => manifest.target === "main")).toHaveLength(1);
          expect(manager.hasPendingWork()).toBe(true);
        }
        enabled = false;
        await manager.sync();
        expect(manager.hasPendingWork()).toBe(false);
      } finally {
        await manager.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    }), { numRuns: 5 });
  });
});

it("captures real main-thread work that finishes before the CPU trigger runs", async () => {
  const { createMainProcessHotCpuTarget } = await import("./main-process-hot-cpu-target");
  const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-oracle-"));
  const result = await createHotCpuProfileSession({ config: config(root), target: "main", versions });
  if (!result.ok) throw new Error(result.message);
  const capture = { ...result.session, appendEvent: async () => {}, appendSample: async () => {} };
  let hot = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const profiler = new HotCpuProfiler({
    config: config(root), session: capture, logger,
    target: createMainProcessHotCpuTarget(),
    getAppMetrics: () => [{ pid: process.pid, cpu: { percentCPUUsage: hot ? 90 : 0, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1, peakWorkingSetSize: 1 } }] as ProcessMetric[]
  });
  try {
    await profiler.start();
    await vi.advanceTimersByTimeAsync(0);
    function preTriggerCpuBurst() {
      const end = performance.now() + 150;
      while (performance.now() < end) Math.sqrt(Math.random());
    }
    preTriggerCpuBurst();
    hot = true;
    await vi.advanceTimersByTimeAsync(100);
    await profiler.stop("app-quit");
    const profile: Profiler.Profile = JSON.parse(await readFile(capture.createProfilePath(1), "utf8"));
    const burstIds = new Set(profile.nodes.filter((node) => node.callFrame.functionName === "preTriggerCpuBurst").map((node) => node.id));
    expect(burstIds.size).toBeGreaterThan(0);
    expect(profile.samples!.some((id) => burstIds.has(id))).toBe(true);
    expect((JSON.parse(await readFile(join(capture.directoryPath, "session.json"), "utf8")))).toMatchObject({ target: "main", artifacts: ["main-hot-0001.cpuprofile"] });
  } finally {
    await profiler.stop();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

it("waits for startup to release main-process profiler ownership", async () => {
  const { createMainProcessHotCpuTarget } = await import("./main-process-hot-cpu-target");
  const { MainProcessCpuProfiler } = await import("./main-process-cpu-profiler");
  const { createStartupCpuProfileSession } = await import("./startup-cpu-profile-session");
  const { resolveStartupCpuProfileConfig } = await import("./startup-cpu-profile-config");
  const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-ownership-"));
  const startupConfig = resolveStartupCpuProfileConfig({ enabled: true, outputRoot: root, env: {} });
  if (!startupConfig.enabled) throw new Error("enabled");
  const created = await createStartupCpuProfileSession({ config: startupConfig, versions });
  if (!created.ok) throw new Error(created.message);
  const startup = new MainProcessCpuProfiler({ session: created.session, logger });
  const target = createMainProcessHotCpuTarget();
  try {
    expect(await startup.start()).toBe(true);
    expect(target.debugger.isAttached()).toBe(true);
    expect(() => target.debugger.attach("1.3")).toThrow("already owned");
    // A failed or foreign hot recorder must not disconnect startup's session.
    target.debugger.detach();
    expect(target.debugger.isAttached()).toBe(true);
    expect(await startup.stop()).toBe(true);
    target.debugger.attach("1.3");
    await target.debugger.sendCommand("Profiler.enable");
    await target.debugger.sendCommand("Profiler.start");
    const profile = await target.debugger.sendCommand("Profiler.stop") as { profile: Profiler.Profile };
    expect(profile.profile.nodes.length).toBeGreaterThan(0);
  } finally {
    target.debugger.detach();
    await startup.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("joins shutdown while arming, discards untriggered history, and leaves no timers", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("Profiler.enable", "Profiler.start"), fc.boolean(), async (blocked, fails) => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-stop-"));
    const capture = await session(root);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target = recorder();
    const sendCommand = target.debugger.sendCommand;
    target.debugger.sendCommand = async (method) => {
      if (method === blocked) {
        enter();
        await gate;
        if (fails) throw new Error("late inspector failure");
      }
      return sendCommand(method);
    };
    const profiler = new HotCpuProfiler({ config: config(root), session: capture, logger, target: { debugger: target.debugger, getOSProcessId: () => 42 }, getAppMetrics: () => [] });
    try {
      const started = profiler.start();
      await entered;
      let stopped = false;
      const stopping = profiler.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await Promise.all([started, stopping, profiler.stop()]);
      expect(target.debugger.isAttached()).toBe(false);
      expect((await readdir(capture.directoryPath)).filter((name) => name.endsWith(".cpuprofile"))).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await profiler.stop();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  }), { numRuns: 8 });
});

it("hands renderer ownership to heap monitoring while keeping main CPU recording armed", async () => {
  vi.useFakeTimers();
  const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-heap-"));
  let heapMonitorEnabled = false;
  const manager = new DiagnosticsManager({ outputRoot: root, getDiagnostics: () => ({ ...DIAGNOSTICS_DEFAULTS, hotCpuProfilingEnabled: true, heapMonitorEnabled }), onHotCpuHeapSnapshotLimitReached: () => {} });
  const target = recorder();
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id: 1, debugger: target.debugger, isDestroyed: () => false, getOSProcessId: () => 101, takeHeapSnapshot: async () => {} } });
  try {
    manager.attachWindow(window as unknown as BrowserWindow);
    await manager.sync();
    expect(target.commands.filter((method) => method === "Profiler.start")).toHaveLength(1);
    heapMonitorEnabled = true;
    await manager.sync();
    expect(target.debugger.isAttached()).toBe(true); // Heap monitor owns it.
    expect(target.commands.filter((method) => method === "Profiler.stop")).toHaveLength(1);
    expect(target.commands.filter((method) => method === "Profiler.start")).toHaveLength(1);
    heapMonitorEnabled = false;
    await manager.sync();
    expect(target.commands.filter((method) => method === "Profiler.start")).toHaveLength(2);
    const manifests = await Promise.all((await readdir(root)).map(async (name) => JSON.parse(await readFile(join(root, name, "session.json"), "utf8"))));
    expect(manifests.filter((manifest) => manifest.target === "main")).toHaveLength(1);
  } finally {
    await manager.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
