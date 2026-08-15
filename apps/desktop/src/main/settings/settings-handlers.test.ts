import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppSettingsSnapshot } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { registerSettingsHandlers, settingsSnapshot } from "./settings-handlers";
import { SettingsService } from "./settings-service";

function freshService(): SettingsService {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-settings-"));
  return new SettingsService(join(dir, "settings.json"));
}

describe("settings handlers", () => {
  it("reads a fully-defaulted snapshot from empty storage", async () => {
    const bus = new CommandBus();
    registerSettingsHandlers(bus, freshService(), {
      diagnosticsOutputRoot: "/diag",
      onChanged: () => undefined
    });

    const r = await bus.dispatch("settings:read", undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.general.developerMode).toBe(false);
    expect(r.value.general.sidebarTextSize).toBe("md");
    expect(r.value.general.sidebarDensity).toBe("comfortable");
    expect(r.value.experimental.lineageAllBranches).toBe(false);
    expect(r.value.diagnostics.heapMonitorEnabled).toBe(false);
    expect(r.value.diagnostics.hotCpuProfilingTriggerMode).toBe("sustained");
    // No PWRGIT_* diagnostics vars in the test env → nothing env-forced.
    expect(r.value.diagnosticsEnv).toEqual({
      heapMonitorForcedOn: false,
      hotCpuProfilingForcedOn: false,
      startupCpuProfilingForcedOn: false
    });
    expect(r.value.diagnosticsOutputRoot).toBe("/diag");
  });

  it("applies sparse patches, persists them, and notifies", async () => {
    const service = freshService();
    const bus = new CommandBus();
    const changes: AppSettingsSnapshot[] = [];
    registerSettingsHandlers(bus, service, {
      diagnosticsOutputRoot: "/diag",
      onChanged: (snapshot) => changes.push(snapshot)
    });

    const r = await bus.dispatch("settings:update", {
      patch: {
        general: { developerMode: true },
        diagnostics: { hotCpuProfilingEnabled: true, heapMonitorEnabled: true }
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.general.developerMode).toBe(true);
    expect(r.value.diagnostics.hotCpuProfilingEnabled).toBe(true);
    // Untouched keys keep their defaults.
    expect(r.value.diagnostics.hotCpuProfilingStartDelayMs).toBe(0);
    expect(changes).toHaveLength(1);
    // Only the changed keys are stored sparsely.
    expect(service.get().diagnostics).toEqual({
      hotCpuProfilingEnabled: true,
      heapMonitorEnabled: true
    });
  });

  it("drops unknown values and clamps the heap snapshot limit", async () => {
    const service = freshService();
    const bus = new CommandBus();
    registerSettingsHandlers(bus, service, {
      diagnosticsOutputRoot: "/diag",
      onChanged: () => undefined
    });

    const r = await bus.dispatch("settings:update", {
      patch: {
        diagnostics: {
          // Off-menu values arriving over IPC must not persist.
          hotCpuProfilingStartDelayMs: 1_234 as never,
          hotCpuProfilingTriggerMode: "warp" as never,
          hotCpuProfilingHeapSnapshotLimit: 99
        }
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.diagnostics.hotCpuProfilingStartDelayMs).toBe(0);
    expect(r.value.diagnostics.hotCpuProfilingTriggerMode).toBe("sustained");
    expect(r.value.diagnostics.hotCpuProfilingHeapSnapshotLimit).toBe(3);
  });

  it("snapshot helper merges stored values over defaults", () => {
    const service = freshService();
    service.update({ experimental: { lineageAllBranches: true } });
    const snapshot = settingsSnapshot(service, "/diag");
    expect(snapshot.experimental.lineageAllBranches).toBe(true);
    expect(snapshot.diagnostics.startupCpuProfilingEnabled).toBe(false);
  });
});

describe("appearance axes", () => {
  it("round-trips the sidebar text size and density", async () => {
    const bus = new CommandBus();
    const service = freshService();
    registerSettingsHandlers(bus, service, {
      diagnosticsOutputRoot: "/diag",
      onChanged: () => undefined
    });

    const r = await bus.dispatch("settings:update", {
      patch: { general: { sidebarTextSize: "lg", sidebarDensity: "compact" } }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.general.sidebarTextSize).toBe("lg");
    expect(r.value.general.sidebarDensity).toBe("compact");
    // Stored sparsely — an untouched key must not be written back as a value.
    expect(service.get().general).toEqual({
      sidebarTextSize: "lg",
      sidebarDensity: "compact"
    });
  });

  it("drops out-of-range notches instead of stamping them on <html>", async () => {
    const bus = new CommandBus();
    const service = freshService();
    registerSettingsHandlers(bus, service, {
      diagnosticsOutputRoot: "/diag",
      onChanged: () => undefined
    });

    // These cross IPC as plain strings and end up as a `data-*` attribute, so
    // an unvalidated value would ship an attribute no stylesheet answers to.
    const r = await bus.dispatch("settings:update", {
      patch: {
        general: {
          sidebarTextSize: "xxl" as never,
          sidebarDensity: "cozy" as never
        }
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.general.sidebarTextSize).toBe("md");
    expect(r.value.general.sidebarDensity).toBe("comfortable");
    expect(service.get().general ?? {}).toEqual({});
  });
});
