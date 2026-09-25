import { describe, expect, it } from "vitest";
import {
  countOutcomes,
  estimateRemainingMs,
  finishedCount,
  formatRemaining,
  progressValueText
} from "./bulk-sync-progress";

describe("countOutcomes", () => {
  it("counts every outcome, including the ones that never happened", () => {
    const counts = countOutcomes(["success", "failed", "success", "skipped"]);
    expect(counts).toEqual({
      success: 2,
      partial: 0,
      skipped: 1,
      failed: 1,
      cancelled: 0
    });
    expect(finishedCount(counts)).toBe(4);
  });
});

describe("estimateRemainingMs", () => {
  it("offers nothing until three repositories and five seconds are in", () => {
    expect(estimateRemainingMs(60_000, 2, 80)).toBeNull();
    expect(estimateRemainingMs(4_999, 10, 80)).toBeNull();
    expect(estimateRemainingMs(5_000, 3, 80)).not.toBeNull();
  });

  it("projects the observed throughput over what is left", () => {
    // 44 finished in 42s is the pool's rate; 36 more at that rate.
    expect(estimateRemainingMs(42_000, 44, 80)).toBeCloseTo(
      (36 * 42_000) / 44
    );
  });

  it("has nothing to estimate once every repository has finished", () => {
    expect(estimateRemainingMs(30_000, 80, 80)).toBeNull();
  });
});

describe("formatRemaining", () => {
  it.each([
    [2_000, "a few seconds left"],
    [31_000, "about 35s left"],
    [35_000, "about 35s left"],
    [57_000, "about 1m left"],
    [150_000, "about 3m left"],
    [3_900_000, "about 1h 05m left"]
  ])("%i ms reads %s", (ms, label) => {
    expect(formatRemaining(ms)).toBe(label);
  });
});

describe("progressValueText", () => {
  it("names the position, then only the trouble that happened", () => {
    expect(
      progressValueText(countOutcomes(["success", "partial"]), 80)
    ).toBe("2 of 80 repositories finished");
    expect(
      progressValueText(countOutcomes(["failed", "cancelled", "cancelled"]), 3)
    ).toBe("3 of 3 repositories finished, 1 failed, 2 cancelled");
    expect(progressValueText(countOutcomes([]), 1)).toBe(
      "0 of 1 repository finished"
    );
  });
});
