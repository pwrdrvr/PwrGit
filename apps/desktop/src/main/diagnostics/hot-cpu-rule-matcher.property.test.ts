import fc from "fast-check";
import { expect, it } from "vitest";
import { readHotCpuRules, type HotCpuTriggerMode } from "@pwrgit/shared";
import { resolveHotCpuRules } from "./hot-cpu-profile-config";
import { HotCpuRuleMatcher } from "./hot-cpu-rule-matcher";

const cpu = fc.oneof(fc.constantFrom(0, 15, 50, 400), fc.integer({ min: 0, max: 450 }));
const modes = fc.constantFrom<HotCpuTriggerMode>("spike", "sustained", "slowburn");

it("matches every migrated legacy mode against the original consecutive-sample predicate", () => {
  fc.assert(fc.property(modes, fc.array(cpu), (mode, readings) => {
    const { rules, intervalMs } = resolveHotCpuRules(readHotCpuRules(undefined, mode), {});
    const matcher = new HotCpuRuleMatcher();
    const count = mode === "spike" ? 1 : 2;
    const floor = mode === "slowburn" ? 15 : 50;
    readings.forEach((cpuPercent, index) => {
      const expected = index + 1 >= count && readings.slice(index + 1 - count, index + 1).every((reading) => reading >= floor);
      const matches = matcher.sample({ cpuPercent, durationMs: 2000, source: "cumulative-cpu" }, rules, intervalMs);
      expect(matches.map((match) => match.id)).toEqual(expected ? [mode] : []);
    });
  }));
});

it("reports every independent window with enough measured CPU time in rule order", () => {
  fc.assert(fc.property(
    fc.constantFrom("spike" as const, "sustained" as const), cpu, cpu,
    fc.array(fc.record({ cpuPercent: cpu, intervalAdjustment: fc.integer({ min: -90, max: 50 }), reset: fc.boolean() }), { maxLength: 80 }),
    (mode, highThreshold, slowThreshold, timeline) => {
      const settings = readHotCpuRules(undefined, mode);
      settings.spike.durationMs = 1_000;
      settings[mode].thresholdPercent = Math.min(400, Math.max(1, highThreshold));
      settings.slowburn = { enabled: true, thresholdPercent: Math.min(400, Math.max(1, slowThreshold)), durationMs: 4_000 };
      const { rules, intervalMs } = resolveHotCpuRules(settings, {});
      const matcher = new HotCpuRuleMatcher();
      let sinceReset: typeof timeline = [];
      for (const sample of timeline) {
        if (sample.reset) { matcher.reset(); sinceReset = []; continue; }
        sinceReset.push(sample);
        const matches = matcher.sample({
          cpuPercent: sample.cpuPercent, durationMs: intervalMs + sample.intervalAdjustment, source: "cumulative-cpu"
        }, rules, intervalMs);
        const expected = rules.filter((rule) => {
          const window = sinceReset.slice(-rule.sampleCount);
          const wallMs = window.reduce((sum, sample) => sum + intervalMs + sample.intervalAdjustment, 0);
          return window.length === rule.sampleCount && wallMs >= rule.durationMs - 50 &&
            window.every(({ cpuPercent }) => cpuPercent >= rule.thresholdPercent);
        });
        expect(matches.map((match) => match.id)).toEqual(expected.map((rule) => rule.id));
      }
    }
  ));
});

it("uses the real cadence for both canonical rules even when it does not divide the saved windows", () => {
  const settings = readHotCpuRules(undefined, "spike");
  settings.spike.durationMs = 1000;
  settings.slowburn.enabled = true;
  const { intervalMs, rules } = resolveHotCpuRules(settings, { PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "3000" });
  const matcher = new HotCpuRuleMatcher();
  expect(rules).toEqual([
    { id: "spike", thresholdPercent: 50, durationMs: 3000, sampleCount: 1 },
    { id: "slowburn", thresholdPercent: 15, durationMs: 4000, sampleCount: 2 }
  ]);
  expect(matcher.sample({ cpuPercent: 20, durationMs: 3000, source: "cumulative-cpu" }, rules, intervalMs)).toEqual([]);
  expect(matcher.sample({ cpuPercent: 80, durationMs: 3000, source: "cumulative-cpu" }, rules, intervalMs)).toMatchObject([
    { id: "spike", sampleCount: 1, sampleIntervalMs: 3000, observedDurationMs: 3000 },
    { id: "slowburn", sampleCount: 2, sampleIntervalMs: 3000, observedDurationMs: 6000 }
  ]);
  expect(settings.spike.durationMs).toBe(1000);
  expect(settings.slowburn.durationMs).toBe(4000);

  const forcedCount = resolveHotCpuRules(settings, {
    PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "3000", PWRGIT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "3"
  });
  expect(forcedCount.rules.map(({ sampleCount, durationMs }) => [sampleCount, durationMs]))
    .toEqual([[1, 3000], [3, 9000]]);
});

it("preserves the legacy cadence-only and explicit mode workflows", () => {
  const intervalOverride = { PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "1000" };
  const sustained = readHotCpuRules(undefined, "sustained");
  expect(resolveHotCpuRules(sustained, intervalOverride, true).rules)
    .toEqual([{ id: "sustained", thresholdPercent: 50, durationMs: 2000, sampleCount: 2 }]);
  expect(resolveHotCpuRules(sustained, intervalOverride).rules)
    .toEqual([{ id: "sustained", thresholdPercent: 50, durationMs: 4000, sampleCount: 4 }]);
  expect(resolveHotCpuRules(readHotCpuRules(undefined, "spike"), intervalOverride, true).rules)
    .toEqual([{ id: "spike", thresholdPercent: 50, durationMs: 1000, sampleCount: 1 }]);

  const settings = readHotCpuRules(undefined, "spike");
  settings.spike.durationMs = 1000;
  settings.spike.thresholdPercent = 120;
  settings.slowburn.enabled = true;
  settings.slowburn.durationMs = 30_000;
  const override = resolveHotCpuRules(settings, {
    PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE: " Slowburn ",
    PWRGIT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "99",
    PWRGIT_HOT_CPU_PROFILING_SLOWBURN_THRESHOLD_PERCENT: "17.5",
    PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS: "750",
    PWRGIT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "3",
    PWRGIT_HOT_CPU_PROFILING_DURATION_MS: "5000"
  });
  expect(override).toMatchObject({ intervalMs: 750, profileDurationMs: 5000, thresholdPercent: 99,
    rules: [{ id: "slowburn", thresholdPercent: 17.5, durationMs: 2250, sampleCount: 3 }] });
  expect(override.overrides).toHaveLength(6);
  expect(resolveHotCpuRules(settings, { PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike" }).rules)
    .toEqual([{ id: "spike", thresholdPercent: 50, durationMs: 2000, sampleCount: 1 }]);
});
