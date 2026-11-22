import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profiler } from "node:inspector";
import { app, contentTracing, type BrowserWindow, type ProcessMetric } from "electron";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_DEFAULTS, readHotCpuRules, type HotCpuProfileCapturedEvent } from "@pwrgit/shared";
import { DiagnosticsManager } from "./diagnostics-manager";
import { HotCpuProfiler } from "./hot-cpu-profiler";
import { createHotCpuProfileSession } from "./hot-cpu-profile-session";
import { resolveHotCpuProfileConfig } from "./hot-cpu-profile-config";

vi.mock("electron", () => ({
  app: { getVersion: () => "test", getAppMetrics: vi.fn(() => []) },
  contentTracing: { startRecording: vi.fn(), stopRecording: vi.fn() }
}));
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
  const config = resolveHotCpuProfileConfig({ enabled: true, outputRoot: root, triggerMode: "spike", env: { PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "100" } });
  if (!config.enabled) throw new Error("enabled");
  return { ...config, profileDurationMs: 500, maxProfiles: 1 };
}

async function session(root: string) {
  const result = await createHotCpuProfileSession({ config: config(root), versions });
  if (!result.ok) throw new Error(result.message);
  return result.session;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(app.getAppMetrics).mockReset().mockReturnValue([]);
  vi.mocked(contentTracing.startRecording).mockReset();
  vi.mocked(contentTracing.stopRecording).mockReset();
});

describe("Chromium trace follows the renderer capture lifecycle", () => {
  it("lets the first window proceed if native trace start never acknowledges", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(contentTracing.startRecording).mockImplementation(() => new Promise<never>(() => {}));
    vi.mocked(contentTracing.stopRecording).mockRejectedValue(
      new Error("Failed to stop tracing - no trace in progress")
    );
    const manager = new DiagnosticsManager({
      outputRoot: tmpdir(),
      getDiagnostics: () => ({
        ...DIAGNOSTICS_DEFAULTS,
        hotCpuProfilingEnabled: true,
        hotCpuProfilingCaptureChromiumTrace: true
      }),
      onHotCpuHeapSnapshotLimitReached: () => {}
    });
    try {
      let mayOpen = false;
      const preparing = manager.prepareFirstRendererTrace().then(() => { mayOpen = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(mayOpen).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await preparing;
      expect(mayOpen).toBe(true);
    } finally {
      await manager.shutdown();
    }
  });

  it.each(["disarm", "trace-off", "heap", "exhaust", "close", "timeout", "profile-failed"] as const)(
    "preserves triggered captures and releases the trace when renderers %s",
    async (transition) => {
      const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-lifecycle-"));
      let settings = {
        ...DIAGNOSTICS_DEFAULTS,
        hotCpuProfilingEnabled: true,
        hotCpuProfilingRules: readHotCpuRules(undefined, "spike"),
        hotCpuProfilingCaptureChromiumTrace: true
      };
      vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_START_DELAY_MS", "20");
      vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS", "20");
      vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE", "spike");
      vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_MAX_PROFILES", transition === "timeout" ? "2" : "1");
      vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_DURATION_MS",
        transition === "exhaust" || transition === "timeout" || transition === "profile-failed" ? "50" : "60000");

      let cpu = transition === "close" ? 0 : 90;
      let destroyed = false;
      const started = vi.mocked(contentTracing.startRecording);
      let nativeRecording = false;
      let exports = 0;
      let rawPath: string | undefined;
      const hangs = transition === "timeout";
      started.mockImplementation(async () => {
        expect(nativeRecording).toBe(false);
        nativeRecording = true;
      });
      vi.mocked(contentTracing.stopRecording).mockImplementation(async (file) => {
        if (!nativeRecording) throw new Error("Failed to stop tracing - no trace in progress");
        nativeRecording = false;
        exports++;
        rawPath = file;
        if (hangs && exports === 1) await new Promise<never>(() => {});
        if (file) await writeFile(file, JSON.stringify({ traceEvents: [] }));
        return file ?? join(directory, "discarded.json");
      });
      const reads = vi.mocked(app.getAppMetrics).mockImplementation(() => [{
        pid: 42,
        cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 1, peakWorkingSetSize: 1 }
      }] as ProcessMetric[]);
      const notify = vi.fn();
      const manager = new DiagnosticsManager({
        outputRoot: directory,
        getDiagnostics: () => settings,
        onHotCpuHeapSnapshotLimitReached: () => {},
        onHotCpuProfileCaptured: notify
      });
      const target = recorder();
      if (transition === "profile-failed") {
        const send = target.debugger.sendCommand;
        target.debugger.sendCommand = async (method) => {
          if (method === "Profiler.stop") throw new Error("fixture profiler failure");
          return send(method);
        };
      }
      const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => destroyed,
        webContents: {
          id: 1, getOSProcessId: () => 42, isDestroyed: () => destroyed,
          debugger: target.debugger
        }
      });
      try {
        if (transition === "close" || transition === "exhaust") {
          await manager.sync();
          expect(started).not.toHaveBeenCalled();
        }
        manager.attachWindow(window as unknown as BrowserWindow);
        await manager.sync();
        expect(nativeRecording).toBe(true);
        const rendererDirectory = (await Promise.all((await readdir(directory)).map(async (name) => {
          const path = join(directory, name);
          const manifest = JSON.parse(await readFile(join(path, "session.json"), "utf8"));
          return manifest.target === "renderer" ? path : null;
        }))).find((path) => path !== null)!;

        if (transition === "close") {
          destroyed = true;
          window.emit("closed");
          await manager.sync();
          expect(notify).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(async () => {
            const events = await readFile(join(rendererDirectory, "events.ndjson"), "utf8");
            expect(events).toContain('"type":"profile-started"');
          });
          if (transition === "disarm" || transition === "heap" || transition === "trace-off") {
            settings = {
              ...settings,
              hotCpuProfilingEnabled: transition !== "disarm",
              heapMonitorEnabled: transition === "heap",
              hotCpuProfilingCaptureChromiumTrace: transition !== "trace-off"
            };
            await manager.sync();
          }
          if (transition === "trace-off") await manager.shutdown();
          if (hangs) cpu = 0;
          if (transition === "profile-failed") {
            await vi.waitFor(async () => {
              expect(await readFile(join(rendererDirectory, "events.ndjson"), "utf8")).toContain('"type":"profile-stop-failed"');
            });
            await manager.shutdown();
            expect(notify).not.toHaveBeenCalled();
          } else {
            await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce(), { timeout: 6_000 });
          }
          const artifacts = JSON.parse(await readFile(join(rendererDirectory, "session.json"), "utf8")).artifacts;
          expect(artifacts).toEqual(transition === "profile-failed" ? [] : hangs || transition === "trace-off"
            ? ["renderer-hot-0001.cpuprofile"]
            : ["renderer-hot-0001.cpuprofile", "renderer-hot-0001.trace.json"]);
          if (transition === "trace-off" || transition === "profile-failed") {
            expect(exports).toBe(1);
            await expect(readFile(rawPath!)).rejects.toMatchObject({ code: "ENOENT" });
          }
          if (hangs) {
            // CPU sampling continues even though native trace export never acknowledged.
            const readCount = reads.mock.calls.length;
            await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(readCount));
            settings = { ...settings, hotCpuProfilingEnabled: false };
            await manager.sync();
          }
        }
        await vi.waitFor(() => expect(nativeRecording).toBe(false));
        if (transition === "exhaust" || transition === "close") {
          cpu = 0;
          const next = Object.assign(new EventEmitter(), {
            isDestroyed: () => false,
            webContents: { ...window.webContents, id: 2, isDestroyed: () => false, debugger: recorder().debugger }
          });
          manager.attachWindow(next as unknown as BrowserWindow);
          await manager.sync();
          expect(nativeRecording).toBe(true);
        }
      } finally {
        await manager.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    }, 9_000
  );

  it("lets another renderer capture while the first renderer's Profiler.stop is stalled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pwrgit-trace-stalled-renderer-"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_START_DELAY_MS", "20");
    vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS", "100");
    vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE", "spike");
    vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_DURATION_MS", "1000");
    vi.stubEnv("PWRGIT_HOT_CPU_PROFILING_MAX_PROFILES", "1");
    let hotPid = 42;
    vi.mocked(app.getAppMetrics).mockImplementation(() => [42, 43].map((pid) => ({
      pid, cpu: { percentCPUUsage: pid === hotPid ? 90 : 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 1, peakWorkingSetSize: 1 }
    })) as ProcessMetric[]);
    const starts = vi.mocked(contentTracing.startRecording).mockResolvedValue(undefined);
    const exports: string[] = [];
    vi.mocked(contentTracing.stopRecording).mockImplementation(async (file = "") => {
      await writeFile(file, '{"traceEvents":[]}');
      exports.push(file);
      return file;
    });

    let releaseStop!: () => void;
    const stalled = new Promise<void>((resolve) => { releaseStop = resolve; });
    const first = recorder();
    const send = first.debugger.sendCommand;
    const waitForStop = vi.fn(() => stalled);
    first.debugger.sendCommand = async (method) => {
      if (method === "Profiler.stop") await waitForStop();
      return send(method);
    };
    const notify = vi.fn();
    const manager = new DiagnosticsManager({
      outputRoot: directory,
      getDiagnostics: () => ({
        ...DIAGNOSTICS_DEFAULTS, hotCpuProfilingEnabled: true,
        hotCpuProfilingRules: readHotCpuRules(undefined, "spike"), hotCpuProfilingCaptureChromiumTrace: true
      }),
      onHotCpuHeapSnapshotLimitReached: () => {},
      onHotCpuProfileCaptured: notify
    });
    function attach(pid: number, target: ReturnType<typeof recorder>) {
      manager.attachWindow(Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        webContents: { id: pid, getOSProcessId: () => pid, isDestroyed: () => false, debugger: target.debugger }
      }) as unknown as BrowserWindow, String(pid));
    }
    try {
      attach(42, first);
      attach(43, recorder());
      await manager.sync();
      await vi.waitFor(() => {
        expect(waitForStop).toHaveBeenCalledOnce();
        expect(exports).toHaveLength(1);
      }, { timeout: 3_000 });
      expect(starts).toHaveBeenCalledOnce();
      await expect(readFile(exports[0]!, "utf8")).resolves.toBe('{"traceEvents":[]}');

      await vi.advanceTimersByTimeAsync(17_000);
      await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
      await expect(readFile(exports[0]!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(notify).not.toHaveBeenCalled();

      hotPid = 43;
      await vi.waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith(expect.anything(), "43"), { timeout: 3_000 });
      const event = notify.mock.calls[0]![0];
      const manifest = JSON.parse(await readFile(join(event.sessionDirectory, "session.json"), "utf8"));
      expect(manifest.artifacts).toEqual(["renderer-hot-0001.cpuprofile", "renderer-hot-0001.trace.json"]);
    } finally {
      releaseStop();
      await manager.shutdown();
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it.each(["missing metric", "new PID", "reused PID", "counter reset", "long gap", "clock jump"] as const)(
  "uses only continuous monotonic CPU evidence across %s",
  async (discontinuity) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-continuity-"));
    const base = resolveHotCpuProfileConfig({ enabled: true, outputRoot: root, env: {
      PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "100"
    } });
    if (!base.enabled) throw new Error("enabled");
    const created = await createHotCpuProfileSession({ config: base, versions });
    if (!created.ok) throw new Error(created.message);
    const events: string[] = [];
    let pid = 42;
    let creationTime = 1;
    let seconds = 1;
    let missing = false;
    let monotonicOffset = 0;
    const target = recorder();
    const originalNow = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => originalNow() + monotonicOffset);
    const profiler = new HotCpuProfiler({
      config: base, logger,
      session: { ...created.session, appendSample: async () => {}, appendEvent: async (event) => { events.push(event.type); } },
      target: { debugger: target.debugger, getOSProcessId: () => pid },
      getAppMetrics: () => missing ? [] : [{
        pid, creationTime, cpu: { cumulativeCPUUsage: seconds, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 1, peakWorkingSetSize: 1 }
      }] as ProcessMetric[]
    });
    const sample = async () => {
      seconds += 0.1;
      await vi.advanceTimersByTimeAsync(100);
    };
    try {
      await profiler.start();
      await vi.advanceTimersByTimeAsync(0);
      await sample();
      if (discontinuity === "missing metric") {
        missing = true;
        await sample();
        missing = false;
      }
      if (discontinuity === "new PID") pid++;
      if (discontinuity === "reused PID") creationTime++;
      if (discontinuity === "counter reset") seconds = 0;
      if (discontinuity === "long gap") { monotonicOffset += 100; seconds += 0.1; }
      if (discontinuity === "clock jump") vi.setSystemTime(new Date("2040-01-01"));
      await sample();
      if (discontinuity !== "clock jump") {
        await sample();
        expect(events).not.toContain("profile-started");
        await sample();
      }
      expect(events.filter((event) => event === "profile-started")).toHaveLength(1);
    } finally {
      await profiler.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);

it("records both matches in one profile, keeps its duration after reconfiguration and does not rearm an exhausted quota", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const root = await mkdtemp(join(tmpdir(), "pwrgit-cpu-two-rules-"));
  const settings = readHotCpuRules(undefined, "sustained");
  settings.slowburn.enabled = true;
  const config = resolveHotCpuProfileConfig({ enabled: true, outputRoot: root, rules: settings, env: {
    PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "100", PWRGIT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "2",
    PWRGIT_HOT_CPU_PROFILING_DURATION_MS: "500",
    PWRGIT_HOT_CPU_PROFILING_MAX_PROFILES: "1"
  } });
  if (!config.enabled) throw new Error("enabled");
  const created = await createHotCpuProfileSession({ config, versions });
  if (!created.ok) throw new Error(created.message);
  let reads = 0;
  const target = recorder();
  const notices: HotCpuProfileCapturedEvent[] = [];
  const trigger = vi.fn(() => async () => {});
  const events: string[] = [];
  const profiler = new HotCpuProfiler({
    config, logger,
    session: { ...created.session, appendSample: async () => {}, appendEvent: async (event) => { events.push(event.type); } },
    target: { debugger: target.debugger, getOSProcessId: () => 42 },
    getAppMetrics: () => [{
      pid: 42, creationTime: 1,
      cpu: { cumulativeCPUUsage: reads++ * 0.0625, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 1, peakWorkingSetSize: 1 }
    }] as ProcessMetric[],
    onProfileTriggered: trigger,
    onProfileWritten: (event) => { notices.push(event); }
  });
  try {
    await profiler.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(trigger).toHaveBeenCalledOnce();
    profiler.reconfigureRules({ ...config, rules: config.rules.slice(0, 1) });
    await vi.advanceTimersByTimeAsync(499);
    expect(reads).toBe(3);
    expect(notices).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    const [event] = notices;
    expect(event).toMatchObject({ triggerMode: "sustained", triggerThresholdPercent: 50, triggerCpuPercent: 62.5, matchedRules: [
      { id: "sustained", thresholdPercent: 50, durationMs: 200, sampleCount: 2, sampleCpuPercent: 62.5, observedDurationMs: 200 },
      { id: "slowburn", thresholdPercent: 15, durationMs: 200, sampleCount: 2, sampleCpuPercent: 62.5, observedDurationMs: 200 }
    ] });
    const profile = JSON.parse(await readFile(event!.profilePath, "utf8"));
    expect(profile.endTime - profile.startTime).toBe(700_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter((event) => event === "profile-started")).toHaveLength(1);
    expect(trigger).toHaveBeenCalledOnce();
  } finally {
    await profiler.stop();
    await rm(root, { recursive: true, force: true });
  }
});

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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  let cumulativeCPUUsage = 0;
  const profiler = new HotCpuProfiler({
    config: config(root), session: capture, logger,
    target: createMainProcessHotCpuTarget(),
    getAppMetrics: () => [{
      pid: process.pid, creationTime: 1,
      cpu: { cumulativeCPUUsage, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 1, peakWorkingSetSize: 1 }
    }] as ProcessMetric[]
  });
  try {
    await profiler.start();
    await vi.advanceTimersByTimeAsync(0);
    function preTriggerCpuBurst() {
      // Let V8 sample this real stack even when the host deschedules the test.
      const start = process.threadCpuUsage();
      let spentMicros: number;
      do {
        for (let i = 0; i < 1000; i++) Math.sqrt(Math.random());
        const { user, system } = process.threadCpuUsage(start);
        spentMicros = user + system;
      } while (spentMicros < 25_000);
    }
    preTriggerCpuBurst();
    // The fake sampler advances 100 ms and observes 75 ms of CPU regardless
    // of the host's scheduling. The saved stack is still from the real inspector.
    cumulativeCPUUsage = 0.075;
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
