import type { HotCpuEffectiveRule, HotCpuRuleMatch, HotCpuTriggerMode } from "@pwrgit/shared";

export type CpuInterval = {
  cpuPercent: number;
  durationMs: number;
  source: HotCpuRuleMatch["measurementSource"];
};

export class HotCpuRuleMatcher {
  private readonly windows = new Map<HotCpuTriggerMode, CpuInterval[]>();

  reset(): void {
    this.windows.clear();
  }

  count(id: HotCpuTriggerMode): number {
    return this.windows.get(id)?.length ?? 0;
  }

  sample(interval: CpuInterval, rules: readonly HotCpuEffectiveRule[], cadenceMs: number): HotCpuRuleMatch[] {
    const matches: HotCpuRuleMatch[] = [];
    const jitterMs = Math.min(50, cadenceMs * 0.05);
    for (const rule of rules) {
      if (interval.cpuPercent < rule.thresholdPercent ||
        (rule.id === "spike" && interval.durationMs > cadenceMs + jitterMs)) {
        this.windows.delete(rule.id);
        continue;
      }
      const window = this.windows.get(rule.id) ?? [];
      window.push(interval);
      if (window.length > rule.sampleCount) window.shift();
      this.windows.set(rule.id, window);
      if (window.length !== rule.sampleCount) continue;
      const observedDurationMs = window.reduce((sum, sample) => sum + sample.durationMs, 0);
      if (observedDurationMs + jitterMs < rule.durationMs) continue;
      const percents = window.map((sample) => sample.cpuPercent);
      matches.push({
        ...rule,
        observedDurationMs,
        sampleCpuPercent: interval.cpuPercent,
        minimumCpuPercent: Math.min(...percents),
        peakCpuPercent: Math.max(...percents),
        measurementSource: interval.source
      });
    }
    return matches;
  }
}
