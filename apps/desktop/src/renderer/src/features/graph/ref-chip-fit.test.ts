import { describe, expect, it } from "vitest";
import { fitRefChips, shedRefChip, type RefChipMeasure } from "./ref-chip-fit";

const measure = (over: Partial<RefChipMeasure>): RefChipMeasure => ({
  available: 400,
  slotRights: [150, 300],
  pill: 24,
  gap: 5,
  total: 2,
  ...over
});

describe("fitRefChips", () => {
  it("shows every capped chip, and no pill, when they all fit", () => {
    expect(fitRefChips(measure({}))).toEqual({ shown: 2, squeeze: false });
  });

  it("needs no room for a pill that nothing folds into", () => {
    // 300 fits in 300 only because no "+N" has to follow it.
    expect(fitRefChips(measure({ available: 300 }))).toEqual({
      shown: 2,
      squeeze: false
    });
  });

  it("keeps room for the pill when chips past the cap fold into it", () => {
    // Both capped chips fit bare, but "+2" has to follow them.
    expect(fitRefChips(measure({ available: 300, total: 4 }))).toEqual({
      shown: 1,
      squeeze: false
    });
    expect(fitRefChips(measure({ available: 329, total: 4 }))).toEqual({
      shown: 2,
      squeeze: false
    });
  });

  it("folds trailing chips whole, leaving room for the pill", () => {
    // 150 + 5 + 24: the first chip and "+1" fit exactly.
    expect(fitRefChips(measure({ available: 179 }))).toEqual({
      shown: 1,
      squeeze: false
    });
  });

  it("forgives the sub-pixel share the strip gives up while the author yields", () => {
    expect(fitRefChips(measure({ available: 299.7 }))).toEqual({
      shown: 2,
      squeeze: false
    });
    expect(fitRefChips(measure({ available: 299.4 }))).toEqual({
      shown: 1,
      squeeze: false
    });
  });

  it("tries the first chip ellipsized when none fits whole", () => {
    expect(fitRefChips(measure({ available: 120 }))).toEqual({
      shown: 1,
      squeeze: true
    });
  });

  it("has nothing to try on a strip with no chips", () => {
    expect(fitRefChips(measure({ slotRights: [], total: 0 }))).toEqual({
      shown: 0,
      squeeze: false
    });
  });
});

describe("shedRefChip", () => {
  it("folds whole chips first, then ellipsizes the last, then folds it", () => {
    const steps = [];
    let fit: ReturnType<typeof shedRefChip> = { shown: 2, squeeze: false };
    while (fit !== null) {
      steps.push(fit);
      fit = shedRefChip(fit);
    }
    expect(steps).toEqual([
      { shown: 2, squeeze: false },
      { shown: 1, squeeze: false },
      { shown: 1, squeeze: true },
      { shown: 0, squeeze: false }
    ]);
  });
});
