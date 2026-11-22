import type { HotCpuTriggerMode } from "./protocol";

export const HOT_CPU_RULE_DURATIONS = {
  spike: [1_000, 2_000],
  sustained: [4_000, 6_000, 10_000, 20_000],
  slowburn: [4_000, 10_000, 30_000, 60_000]
} as const;

type HighCpuMode = Exclude<HotCpuTriggerMode, "slowburn">;

type RuleSettings = {
  thresholdPercent: number;
  durationMs: number;
};

export type HotCpuCaptureRules = {
  high: { enabled: boolean; mode: HighCpuMode };
  spike: RuleSettings;
  sustained: RuleSettings;
  slowburn: RuleSettings & { enabled: boolean };
};

export const DEFAULT_HOT_CPU_RULES: HotCpuCaptureRules = {
  high: { enabled: true, mode: "sustained" },
  spike: { thresholdPercent: 50, durationMs: 2_000 },
  sustained: { thresholdPercent: 50, durationMs: 4_000 },
  slowburn: { enabled: false, thresholdPercent: 15, durationMs: 4_000 }
};

export const HOT_CPU_RULE_LABELS = { spike: "Spike", sustained: "Sustained", slowburn: "Slow burn" };

export function isHotCpuThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHotCpuCaptureRules(value: unknown): value is HotCpuCaptureRules {
  if (!isRecord(value)) return false;
  const { high, slowburn } = value;
  return isRecord(high) && typeof high.enabled === "boolean" &&
    (high.mode === "spike" || high.mode === "sustained") &&
    isRecord(slowburn) && typeof slowburn.enabled === "boolean" &&
    (high.enabled || slowburn.enabled) &&
    (Object.keys(HOT_CPU_RULE_DURATIONS) as HotCpuTriggerMode[]).every((mode) => {
      const rule = value[mode];
      const durations: readonly number[] = HOT_CPU_RULE_DURATIONS[mode];
      return isRecord(rule) && isHotCpuThreshold(rule.thresholdPercent) &&
        typeof rule.durationMs === "number" && durations.includes(rule.durationMs);
    });
}

export function readHotCpuRules(
  value: unknown, legacyMode?: unknown, legacySlowburnThreshold?: unknown
): HotCpuCaptureRules {
  if (value !== undefined) {
    if (!isHotCpuCaptureRules(value)) return readHotCpuRules(undefined);
    const { high, spike, sustained, slowburn } = value;
    return {
      high: { enabled: high.enabled, mode: high.mode },
      spike: { thresholdPercent: spike.thresholdPercent, durationMs: spike.durationMs },
      sustained: { thresholdPercent: sustained.thresholdPercent, durationMs: sustained.durationMs },
      slowburn: { enabled: slowburn.enabled, thresholdPercent: slowburn.thresholdPercent, durationMs: slowburn.durationMs }
    };
  }
  return {
    spike: { ...DEFAULT_HOT_CPU_RULES.spike },
    sustained: { ...DEFAULT_HOT_CPU_RULES.sustained },
    high: { enabled: legacyMode !== "slowburn", mode: legacyMode === "spike" ? "spike" : "sustained" },
    slowburn: {
      ...DEFAULT_HOT_CPU_RULES.slowburn,
      enabled: legacyMode === "slowburn",
      thresholdPercent: isHotCpuThreshold(legacySlowburnThreshold)
        ? legacySlowburnThreshold : DEFAULT_HOT_CPU_RULES.slowburn.thresholdPercent
    }
  };
}

export function legacyHotCpuMode(rules: HotCpuCaptureRules): HotCpuTriggerMode {
  return rules.high.enabled ? rules.high.mode : "slowburn";
}

export function toggleHotCpuRule(rules: HotCpuCaptureRules, group: "high" | "slowburn"): HotCpuCaptureRules {
  const other = group === "high" ? "slowburn" : "high";
  if (rules[group].enabled && !rules[other].enabled) return rules;
  return { ...rules, [group]: { ...rules[group], enabled: !rules[group].enabled } };
}

export function hotCpuRuleIntervalMs(rules: HotCpuCaptureRules): number {
  return rules.high.enabled && rules.high.mode === "spike" && rules.spike.durationMs === 1_000 ? 1_000 : 2_000;
}

export type HotCpuEffectiveRule = RuleSettings & {
  id: HotCpuTriggerMode;
  sampleCount: number;
};

export type HotCpuRuleOverride = {
  keys: string[];
  intervalMs: number;
  profileDurationMs: number;
  rules: HotCpuEffectiveRule[];
};
