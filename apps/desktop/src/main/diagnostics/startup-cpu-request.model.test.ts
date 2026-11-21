import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { CommandBus } from "../command-bus";
import { registerSettingsHandlers, settingsSnapshot } from "../settings/settings-handlers";
import { SettingsService } from "../settings/settings-service";
import { resolveStartupCpuProfileConfig } from "./startup-cpu-profile-config";
import { takeStartupCpuProfileRequest } from "./startup-cpu-request";

// Model test for "Settings profiles the NEXT launch, once". Each launch reads
// a fresh SettingsService from the same file, as a real restart does, and
// makes the decision index.ts makes. The env var is the explicit override and
// profiles every launch that carries it, leaving the setting alone.
type Command =
  | { kind: "arm"; enabled: boolean }
  | { kind: "launch"; env: boolean };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.boolean().map((enabled) => ({ kind: "arm" as const, enabled })),
  fc.boolean().map((env) => ({ kind: "launch" as const, env }))
);

it("profiles exactly the launches that were armed since the previous launch, or carry the env var", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(command, { maxLength: 20 }), async (storedBeforeUpgrade, commands) => {
    const directory = mkdtempSync(join(tmpdir(), "pwrgit-startup-request-"));
    const file = join(directory, "settings.json");
    // A build before this change kept the switch on across launches.
    if (storedBeforeUpgrade) new SettingsService(file).update({ diagnostics: { startupCpuProfilingEnabled: true } });
    let modelArmed = storedBeforeUpgrade;
    try {
      for (const [index, step] of commands.entries()) {
        const label = `step ${index}: ${JSON.stringify(step)}`;
        const settings = new SettingsService(file);
        if (step.kind === "arm") {
          const bus = new CommandBus();
          registerSettingsHandlers(bus, settings, { diagnosticsOutputRoot: directory, onChanged: () => undefined });
          await bus.dispatch("settings:update", { patch: { diagnostics: { startupCpuProfilingEnabled: step.enabled } } });
          modelArmed = step.enabled;
        } else {
          const env = step.env ? { PWRGIT_STARTUP_CPU_PROFILING: "1" } : {};
          const config = resolveStartupCpuProfileConfig({
            enabled: takeStartupCpuProfileRequest(settings),
            outputRoot: directory,
            env
          });
          expect(config.enabled, label).toBe(modelArmed || step.env);
          if (config.enabled) expect(config.armedBy, label).toBe(step.env ? "env" : "settings");
          modelArmed = false;
        }
        expect(settingsSnapshot(new SettingsService(file), directory).diagnostics.startupCpuProfilingEnabled, label).toBe(modelArmed);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }), { numRuns: 200 });
});
