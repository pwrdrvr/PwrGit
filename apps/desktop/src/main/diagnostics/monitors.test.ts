import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeapSession, HeapSessionEvent, HeapSessionSample } from "./heap-session";
import type {
  HotCpuProfileEvent,
  HotCpuProfileSample,
  HotCpuProfileSession
} from "./hot-cpu-profile-session";
import { MainProcessHeapMonitor } from "./main-process-heap-monitor";
import {
  RendererHotCpuProfiler,
  type HotCpuProfileCapturedEvent
} from "./renderer-hot-cpu-profiler";

// Trigger-logic tests for the machinery ported from PwrAgnt, driven through
// the injected seams (readHeap / writeSnapshot / getAppMetrics / structural
// debugger targets) with fake timers — no Electron runtime involved.

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Flush the fire-and-forget promise chains between timer steps. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/** The hot-CPU profiler writes its .cpuprofile with real fs promises, which
 *  need event-loop turns (not just microtasks) even under fake timers. Each
 *  awaited real fs op yields a full turn; bound it so a bug can't hang CI. */
async function waitForRealIo(done: () => boolean): Promise<void> {
  const { access } = await import("node:fs/promises");
  // Bounded by real elapsed time via hrtime (NOT the faked Date/timers): a
  // fixed iteration count of quick access() round-trips can lap a slow real
  // fs write on Windows CI runners, reporting a capture as missing when it
  // just hadn't landed yet.
  const deadline = process.hrtime.bigint() + 10_000_000_000n; // 10s real time
  while (!done() && process.hrtime.bigint() < deadline) {
    await access(".").catch(() => {});
  }
}

describe("MainProcessHeapMonitor", () => {
  function fakeHeapSession() {
    const samples: HeapSessionSample[] = [];
    const events: HeapSessionEvent[] = [];
    const snapshotFiles: string[] = [];
    const session: HeapSession = {
      id: "t",
      directoryName: "heap-test",
      directoryPath: "/diag/heap-test",
      samplesPath: "/diag/heap-test/samples.ndjson",
      eventsPath: "/diag/heap-test/events.ndjson",
      appendSample: async (sample) => {
        samples.push(sample);
      },
      appendEvent: async (event) => {
        events.push(event);
      },
      registerSnapshotFile: async (filename) => {
        snapshotFiles.push(filename);
      }
    };
    return { session, samples, events, snapshotFiles };
  }

  it("snapshots on threshold crossings, honoring cooldown and the max cap", async () => {
    const { session, samples, events, snapshotFiles } = fakeHeapSession();
    // heapUsed per sample (1s apart): baseline, +200 (snap), +200 (cooldown),
    // +50 (no crossing), +150 (cooldown), +200 (cooldown), +200 at t=6s
    // (5s elapsed since snap → snap #2), +200 (max cap).
    const heapUsedSequence = [1000, 1200, 1400, 1450, 1600, 1800, 2000, 2200];
    let readIndex = 0;
    const written: string[] = [];

    const monitor = new MainProcessHeapMonitor({
      session,
      config: {
        enabled: true,
        outputRoot: "/diag",
        intervalMs: 1_000,
        settleDelayMs: 0,
        deltaThresholdBytes: 100,
        snapshotCooldownMs: 5_000,
        maxSnapshots: 2
      },
      logger: quietLogger,
      readHeap: () => {
        const heapUsed = heapUsedSequence[readIndex] ?? 2200;
        readIndex += 1;
        return {
          heapUsed,
          heapTotal: heapUsed * 2,
          rss: 0,
          external: 0,
          arrayBuffers: 0,
          heapSizeLimit: 0,
          totalPhysicalSize: 0,
          totalAvailableSize: 0,
          mallocedMemory: 0,
          peakMallocedMemory: 0
        };
      },
      writeSnapshot: (filePath) => {
        written.push(filePath);
        return filePath;
      }
    });

    await monitor.start(); // settle 0 → baseline sample immediately
    for (let step = 0; step < 7; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsync();
    }
    await monitor.stop();

    expect(samples[0]?.isBaseline).toBe(true);
    expect(written).toHaveLength(2);
    expect(snapshotFiles).toEqual([
      "main-heap-0001.heapsnapshot",
      "main-heap-0002.heapsnapshot"
    ]);
    const skipReasons = events
      .filter((event) => event.type === "snapshot-skipped")
      .map((event) => event.detail?.["reason"]);
    expect(skipReasons).toContain("cooldown");
    expect(skipReasons).toContain("max-snapshots");
  });

  it("never snapshots off the baseline sample", async () => {
    const { session, snapshotFiles } = fakeHeapSession();
    const monitor = new MainProcessHeapMonitor({
      session,
      config: {
        enabled: true,
        outputRoot: "/diag",
        intervalMs: 1_000,
        settleDelayMs: 0,
        deltaThresholdBytes: 1, // any delta would trip it
        snapshotCooldownMs: 0,
        maxSnapshots: 5
      },
      logger: quietLogger,
      readHeap: () => ({
        heapUsed: 999_999,
        heapTotal: 1,
        rss: 0,
        external: 0,
        arrayBuffers: 0,
        heapSizeLimit: 0,
        totalPhysicalSize: 0,
        totalAvailableSize: 0,
        mallocedMemory: 0,
        peakMallocedMemory: 0
      }),
      writeSnapshot: (filePath) => filePath
    });

    await monitor.start();
    await flushAsync();
    await monitor.stop();
    expect(snapshotFiles).toHaveLength(0);
  });
});

describe("RendererHotCpuProfiler", () => {
  function fakeHotCpuSession(directoryPath: string) {
    const samples: HotCpuProfileSample[] = [];
    const events: HotCpuProfileEvent[] = [];
    const artifacts: string[] = [];
    const session: HotCpuProfileSession = {
      id: "t",
      directoryName: "hot-cpu-test",
      directoryPath,
      samplesPath: join(directoryPath, "samples.ndjson"),
      eventsPath: join(directoryPath, "events.ndjson"),
      appendSample: async (sample) => {
        samples.push(sample);
      },
      appendEvent: async (event) => {
        events.push(event);
      },
      createProfilePath: (index) =>
        join(directoryPath, `renderer-hot-${String(index).padStart(4, "0")}.cpuprofile`),
      createHeapSnapshotPath: (index, phase) =>
        join(directoryPath, `renderer-hot-${index}-${phase}.heapsnapshot`),
      registerArtifact: async (filename) => {
        artifacts.push(filename);
      }
    };
    return { session, samples, events, artifacts };
  }

  function fakeDebugger() {
    let attached = false;
    const commands: string[] = [];
    return {
      commands,
      target: {
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        isAttached: () => attached,
        sendCommand: async (method: string): Promise<unknown> => {
          commands.push(method);
          return method === "Profiler.stop"
            ? { profile: { nodes: ["fake"] } }
            : {};
        },
        on: () => {},
        off: () => {}
      }
    };
  }

  const config = {
    enabled: true as const,
    outputRoot: "/diag",
    startDelayMs: 0,
    triggerMode: "sustained" as const,
    intervalMs: 100,
    thresholdPercent: 50,
    slowburnThresholdPercent: 15,
    consecutiveSamples: 2,
    profileDurationMs: 300,
    cooldownMs: 10_000,
    maxProfiles: 1,
    captureHeapSnapshot: false,
    heapSnapshotLimit: 2
  };

  function metricsFor(cpuPercent: number) {
    return [
      {
        pid: 42,
        cpu: { percentCPUUsage: cpuPercent, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 1, peakWorkingSetSize: 1 }
      }
    ] as never;
  }

  it("captures a profile after sustained hot samples, then resumes sampling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrgit-hotcpu-"));
    const { session, samples, events } = fakeHotCpuSession(dir);
    const { target, commands } = fakeDebugger();
    // cold, hot (1 consecutive), hot (2 consecutive → profile)
    const cpuSequence = [10, 60, 60, 20, 20];
    let sampleIndex = 0;
    const captured: HotCpuProfileCapturedEvent[] = [];

    const profiler = new RendererHotCpuProfiler({
      config,
      getAppMetrics: () => metricsFor(cpuSequence[sampleIndex++] ?? 20),
      session,
      target: { debugger: target, getOSProcessId: () => 42 },
      logger: quietLogger,
      onProfileWritten: (event) => {
        captured.push(event);
      }
    });

    await profiler.start();
    await vi.advanceTimersByTimeAsync(0); // startDelay 0 → first sample
    await flushAsync();
    await vi.advanceTimersByTimeAsync(100); // hot #1
    await flushAsync();
    await vi.advanceTimersByTimeAsync(100); // hot #2 → profile starts
    await flushAsync();
    expect(commands).toContain("Profiler.start");

    await vi.advanceTimersByTimeAsync(300); // duration elapses → profile stops
    await waitForRealIo(() => captured.length === 1);
    expect(commands).toContain("Profiler.stop");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.triggerCpuPercent).toBe(60);
    expect(captured[0]?.triggerMode).toBe("sustained");
    const profileJson = readFileSync(captured[0]!.profilePath, "utf8");
    expect(JSON.parse(profileJson)).toEqual({ nodes: ["fake"] });

    // Sampling resumes after the capture (paused-during-profile invariant).
    const samplesAfterCapture = samples.length;
    await vi.advanceTimersByTimeAsync(100);
    await flushAsync();
    expect(samples.length).toBe(samplesAfterCapture + 1);
    expect(
      events.filter((event) => event.type === "profile-written")
    ).toHaveLength(1);

    await profiler.stop();
  });

  it("stays idle below the threshold and on single spikes in sustained mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrgit-hotcpu-"));
    const { session } = fakeHotCpuSession(dir);
    const { target, commands } = fakeDebugger();
    // Alternating hot/cold never reaches 2 consecutive hot samples.
    const cpuSequence = [60, 20, 60, 20, 60, 20];
    let sampleIndex = 0;

    const profiler = new RendererHotCpuProfiler({
      config,
      getAppMetrics: () => metricsFor(cpuSequence[sampleIndex++] ?? 20),
      session,
      target: { debugger: target, getOSProcessId: () => 42 },
      logger: quietLogger
    });

    await profiler.start();
    for (let step = 0; step < 6; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync();
    }
    expect(commands).not.toContain("Profiler.start");
    await profiler.stop();
  });
});
