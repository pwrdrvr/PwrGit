import fc from "fast-check";
import { expect, it } from "vitest";
import { DEFAULT_HOT_CPU_RULES, isHotCpuCaptureRules, readHotCpuRules, toggleHotCpuRule } from "./hot-cpu-rules";

it("remembers each rule and never allows a sequence of editor toggles to disable the last group", () => {
  fc.assert(fc.property(
    fc.constantFrom(undefined, "spike", "sustained", "slowburn", "unknown"),
    fc.integer({ min: 1, max: 400 }),
    fc.array(fc.constantFrom("high" as const, "slowburn" as const)),
    (legacyMode, threshold, toggles) => {
      let rules = readHotCpuRules(undefined, legacyMode, threshold);
      let high = legacyMode !== "slowburn";
      let slowburn = legacyMode === "slowburn";
      for (const group of toggles) {
        if (group === "high" && (!high || slowburn)) high = !high;
        if (group === "slowburn" && (!slowburn || high)) slowburn = !slowburn;
        rules = toggleHotCpuRule(rules, group);
        expect(rules.high.enabled).toBe(high);
        expect(rules.slowburn.enabled).toBe(slowburn);
        expect(rules.high.mode).toBe(legacyMode === "spike" ? "spike" : "sustained");
        expect(rules.slowburn.thresholdPercent).toBe(threshold);
        expect(isHotCpuCaptureRules(rules)).toBe(true);
        expect(readHotCpuRules(rules, "slowburn", 1)).toEqual(rules);
      }
    }
  ));
});

it("uses safe defaults for invalid new settings even if legacy settings are valid", () => {
  const allOff = { ...DEFAULT_HOT_CPU_RULES, high: { enabled: false, mode: "sustained" } };
  for (const invalid of [allOff, null, "spike", {}]) {
    expect(readHotCpuRules(invalid, "slowburn", 90)).toEqual(DEFAULT_HOT_CPU_RULES);
  }
});
