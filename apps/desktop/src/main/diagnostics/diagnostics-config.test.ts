import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHeapMonitorConfig } from "./heap-monitor-config";
import { resolveHotCpuProfileConfig } from "./hot-cpu-profile-config";
import { resolveStartupCpuProfileConfig } from "./startup-cpu-profile-config";

describe("diagnostics config resolvers", () => {
  it("stay disabled without a settings enable or env force", () => {
    expect(
      resolveHeapMonitorConfig({ outputRoot: "/out", env: {} }).enabled
    ).toBe(false);
    expect(
      resolveHotCpuProfileConfig({ outputRoot: "/out", env: {} }).enabled
    ).toBe(false);
    expect(
      resolveStartupCpuProfileConfig({ outputRoot: "/out", env: {} }).enabled
    ).toBe(false);
  });

  it("settings enable resolves defaults; env vars override knobs", () => {
    const heap = resolveHeapMonitorConfig({
      enabled: true,
      outputRoot: "/out",
      env: { PWRGIT_HEAP_DIAGNOSTICS_INTERVAL_MS: "250" }
    });
    expect(heap).toMatchObject({
      enabled: true,
      // The resolver runs the root through path.resolve, which prefixes the
      // current drive on Windows ("/out" → "D:\\out") — compare resolved form.
      outputRoot: path.resolve("/out"),
      intervalMs: 250,
      deltaThresholdBytes: 100 * 1024 * 1024
    });
  });

  it("env can force-enable hot CPU profiling and pin its mode", () => {
    const hot = resolveHotCpuProfileConfig({
      outputRoot: "/out",
      startDelayMs: 5_000,
      env: {
        PWRGIT_HOT_CPU_PROFILING: "1",
        PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE: "slowburn"
      }
    });
    expect(hot).toMatchObject({
      enabled: true,
      startDelayMs: 5_000,
      triggerMode: "slowburn",
      slowburnThresholdPercent: 15
    });
  });

  it("hot CPU settings options flow through when env is silent", () => {
    const hot = resolveHotCpuProfileConfig({
      enabled: true,
      outputRoot: "/out",
      triggerMode: "spike",
      captureHeapSnapshot: true,
      heapSnapshotLimit: 9,
      env: {}
    });
    expect(hot).toMatchObject({
      enabled: true,
      triggerMode: "spike",
      captureHeapSnapshot: true,
      heapSnapshotLimit: 3 // clamped to the hard cap
    });
  });

  it("invalid env values fall back instead of exploding", () => {
    const hot = resolveHotCpuProfileConfig({
      enabled: true,
      outputRoot: "/out",
      env: {
        PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE: "warp",
        PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "-5"
      }
    });
    expect(hot).toMatchObject({
      enabled: true,
      triggerMode: "sustained",
      intervalMs: 2_000
    });
  });
});
