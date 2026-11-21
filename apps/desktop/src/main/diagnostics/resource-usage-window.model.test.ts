import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { RESOURCE_USAGE_RECORDING_MS } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { registerSettingsHandlers, settingsSnapshot } from "../settings/settings-handlers";
import { SettingsService } from "../settings/settings-service";
import { DiagnosticsManager } from "./diagnostics-manager";
import { watchResourceUsage } from "./resource-monitor";

// Model test for "a user-started 24-hour recording stops 24 hours after it
// starts". Real Settings writes (settings:update), the real manager, a real
// settings file that survives restarts, and fake timers whose clock is also
// Date.now(). Only the sampler is a stand-in: running = started − stopped.
const sampler = vi.hoisted(() => ({ running: 0, starts: 0, stopGate: Promise.resolve() }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./resource-monitor", () => ({
  watchResourceUsage: vi.fn(() => {
    sampler.running++;
    sampler.starts++;
    let stopped = false;
    return async () => {
      if (!stopped) sampler.running--;
      stopped = true;
      await sampler.stopGate; // The sampler's last pending write.
    };
  })
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-20T18:43:14.000Z");

type Command =
  | { kind: "toggle"; enabled: boolean }
  | { kind: "advance"; ms: number }
  | { kind: "restart" };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.boolean().map((enabled) => ({ kind: "toggle" as const, enabled })),
  fc.constantFrom(MINUTE, HOUR, 12 * HOUR, 24 * HOUR - MINUTE, 24 * HOUR, 25 * HOUR, 3 * MINUTE + 17_000)
    .map((ms) => ({ kind: "advance" as const, ms })),
  fc.constant({ kind: "restart" as const })
);

afterEach(() => {
  vi.useRealTimers();
});

it("records from turn-on until exactly 24 hours later, across restarts, then turns the setting off", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(command, { maxLength: 14 }), async (legacyOn, commands) => {
    vi.useFakeTimers({ now: START });
    sampler.running = 0;
    sampler.starts = 0;
    vi.mocked(watchResourceUsage).mockClear();
    const directory = mkdtempSync(join(tmpdir(), "pwrgit-resource-window-"));
    const file = join(directory, "settings.json");
    // A build before this change stored only the boolean.
    if (legacyOn) new SettingsService(file).update({ diagnostics: { resourceUsageEnabled: true } });

    let manager: DiagnosticsManager | null = null;
    let bus = new CommandBus();
    const launch = async () => {
      const settings = new SettingsService(file);
      bus = new CommandBus();
      const created: DiagnosticsManager = new DiagnosticsManager({
        outputRoot: directory,
        getDiagnostics: () => settingsSnapshot(settings, directory).diagnostics,
        onHotCpuHeapSnapshotLimitReached: () => undefined,
        persistDiagnostics: (patch) => {
          settings.update({ diagnostics: { ...settings.get().diagnostics, ...patch } });
        }
      });
      registerSettingsHandlers(bus, settings, {
        diagnosticsOutputRoot: directory,
        onChanged: () => { void created.sync(); }
      });
      manager = created;
      await created.sync();
    };
    const stored = () => settingsSnapshot(new SettingsService(file), directory).diagnostics;

    // The model: on, and when it stops. A legacy "on" gets 24h from the
    // first launch that reads it.
    let modelOn = legacyOn;
    let modelExpiresAt: number | null = legacyOn ? START + RESOURCE_USAGE_RECORDING_MS : null;
    const check = (label: string) => {
      expect(sampler.running, label).toBe(modelOn ? 1 : 0);
      expect(stored().resourceUsageEnabled, label).toBe(modelOn);
      expect(stored().resourceUsageExpiresAt, label).toBe(modelExpiresAt === null ? null : new Date(modelExpiresAt).toISOString());
    };

    try {
      await launch();
      check("first launch");
      for (const [index, step] of commands.entries()) {
        const label = `step ${index}: ${JSON.stringify(step)}`;
        if (step.kind === "toggle") {
          await bus.dispatch("settings:update", { patch: { diagnostics: { resourceUsageEnabled: step.enabled } } });
          await manager!.whenIdle();
          if (step.enabled && !modelOn) modelExpiresAt = Date.now() + RESOURCE_USAGE_RECORDING_MS;
          if (!step.enabled) modelExpiresAt = null;
          modelOn = step.enabled;
        } else if (step.kind === "advance") {
          await vi.advanceTimersByTimeAsync(step.ms);
          await manager!.whenIdle();
          if (modelOn && modelExpiresAt !== null && Date.now() >= modelExpiresAt) {
            modelOn = false;
            modelExpiresAt = null;
          }
        } else {
          await manager!.shutdown();
          expect(sampler.running, label).toBe(0);
          await launch();
        }
        check(label);
      }
    } finally {
      await (manager as DiagnosticsManager | null)?.shutdown();
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(sampler.running).toBe(0);
  }), { numRuns: 60 });
}, 120_000);

it("never lets a renderer patch choose or extend the stop time", async () => {
  vi.useFakeTimers({ now: START });
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-resource-window-"));
  try {
    const settings = new SettingsService(join(directory, "settings.json"));
    const bus = new CommandBus();
    registerSettingsHandlers(bus, settings, { diagnosticsOutputRoot: directory, onChanged: () => undefined });
    const forged = "2099-01-01T00:00:00.000Z";
    await bus.dispatch("settings:update", { patch: { diagnostics: { resourceUsageEnabled: true, resourceUsageExpiresAt: forged } } });
    const first = settingsSnapshot(settings, directory).diagnostics.resourceUsageExpiresAt;
    expect(first).toBe(new Date(START + RESOURCE_USAGE_RECORDING_MS).toISOString());
    vi.setSystemTime(START + 5 * HOUR);
    await bus.dispatch("settings:update", { patch: { diagnostics: { resourceUsageEnabled: true } } });
    expect(settingsSnapshot(settings, directory).diagnostics.resourceUsageExpiresAt).toBe(first);
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function manager(file: string, directory: string) {
  const settings = new SettingsService(file);
  const created = new DiagnosticsManager({
    outputRoot: directory,
    getDiagnostics: () => settingsSnapshot(settings, directory).diagnostics,
    onHotCpuHeapSnapshotLimitReached: () => undefined,
    persistDiagnostics: (patch) => {
      settings.update({ diagnostics: { ...settings.get().diagnostics, ...patch } });
    }
  });
  await created.sync();
  return created;
}

it("treats a stored stop time more than 24 hours out as untrusted and still stops within 24 hours", async () => {
  vi.useFakeTimers({ now: START });
  sampler.running = 0;
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-resource-window-"));
  const file = join(directory, "settings.json");
  new SettingsService(file).update({ diagnostics: { resourceUsageEnabled: true, resourceUsageExpiresAt: "2099-01-01T00:00:00.000Z" } });
  const running = await manager(file, directory);
  try {
    expect(sampler.running).toBe(1);
    const stored = () => settingsSnapshot(new SettingsService(file), directory).diagnostics;
    expect(stored().resourceUsageExpiresAt).toBe(new Date(START + RESOURCE_USAGE_RECORDING_MS).toISOString());
    await vi.advanceTimersByTimeAsync(RESOURCE_USAGE_RECORDING_MS);
    await running.whenIdle();
    expect(sampler.running).toBe(0);
    expect(stored().resourceUsageEnabled).toBe(false);
  } finally {
    await running.shutdown();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("stops on wake when the wall clock passed the stop time while timers were paused", async () => {
  vi.useFakeTimers({ now: START });
  sampler.running = 0;
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-resource-window-"));
  const file = join(directory, "settings.json");
  new SettingsService(file).update({ diagnostics: { resourceUsageEnabled: true, resourceUsageExpiresAt: new Date(START + HOUR).toISOString() } });
  const running = await manager(file, directory);
  try {
    expect(sampler.running).toBe(1);
    // Sleep: the wall clock moves, the timer clock does not.
    vi.setSystemTime(START + 2 * HOUR);
    running.recheckResourceUsage();
    await running.whenIdle();
    expect(sampler.running).toBe(0);
    expect(settingsSnapshot(new SettingsService(file), directory).diagnostics.resourceUsageEnabled).toBe(false);
  } finally {
    await running.shutdown();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("a turn-on made while an expired recording is still flushing stays on", async () => {
  vi.useFakeTimers({ now: START });
  sampler.running = 0;
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-resource-window-"));
  const file = join(directory, "settings.json");
  new SettingsService(file).update({ diagnostics: { resourceUsageEnabled: true, resourceUsageExpiresAt: new Date(START + HOUR).toISOString() } });
  const settings = new SettingsService(file);
  const bus = new CommandBus();
  const running: DiagnosticsManager = new DiagnosticsManager({
    outputRoot: directory,
    getDiagnostics: () => settingsSnapshot(settings, directory).diagnostics,
    onHotCpuHeapSnapshotLimitReached: () => undefined,
    persistDiagnostics: (patch) => {
      settings.update({ diagnostics: { ...settings.get().diagnostics, ...patch } });
    }
  });
  registerSettingsHandlers(bus, settings, { diagnosticsOutputRoot: directory, onChanged: () => { void running.sync(); } });
  let flush!: () => void;
  try {
    await running.sync();
    sampler.stopGate = new Promise((resolve) => { flush = resolve; });
    await vi.advanceTimersByTimeAsync(HOUR); // Expires; the stop is now waiting on its write.
    await bus.dispatch("settings:update", { patch: { diagnostics: { resourceUsageEnabled: true } } });
    flush();
    await running.whenIdle();
    await running.whenIdle();
    const stored = settingsSnapshot(new SettingsService(file), directory).diagnostics;
    expect(stored.resourceUsageEnabled).toBe(true);
    expect(stored.resourceUsageExpiresAt).toBe(new Date(START + HOUR + RESOURCE_USAGE_RECORDING_MS).toISOString());
    expect(sampler.running).toBe(1);
  } finally {
    flush?.();
    sampler.stopGate = Promise.resolve();
    await running.shutdown();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});
