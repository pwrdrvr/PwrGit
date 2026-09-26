import { describe, expect, it } from "vitest";
import {
  fitRefChips,
  shedRefChip,
  type RefChipFit,
  type RefChipMeasure
} from "./ref-chip-fit";

const measure = (over: Partial<RefChipMeasure>): RefChipMeasure => ({
  available: 400,
  slotRights: [150, 300],
  pill: 24,
  gap: 5,
  total: 2,
  ...over
});
/** The fit for a row with no tag chip. */
const fit = (over: Partial<RefChipMeasure>): RefChipFit =>
  fitRefChips(measure(over), false);

describe("fitRefChips", () => {
  it("shows every capped chip, and no pill, when they all fit", () => {
    expect(fit({})).toEqual({ shown: 2, squeeze: false, tag: null });
  });

  it("needs no room for a pill that nothing folds into", () => {
    // 300 fits in 300 only because no "+N" has to follow it.
    expect(fit({ available: 300 })).toEqual({ shown: 2, squeeze: false, tag: null });
  });

  it("keeps room for the pill when chips past the cap fold into it", () => {
    // Both capped chips fit bare, but "+2" has to follow them.
    expect(fit({ available: 300, total: 4 })).toEqual({
      shown: 1,
      squeeze: false,
      tag: null
    });
    expect(fit({ available: 329, total: 4 })).toEqual({
      shown: 2,
      squeeze: false,
      tag: null
    });
  });

  it("folds trailing chips whole, leaving room for the pill", () => {
    // 150 + 5 + 24: the first chip and "+1" fit exactly.
    expect(fit({ available: 179 })).toEqual({ shown: 1, squeeze: false, tag: null });
  });

  it("forgives the sub-pixel share the strip gives up while the author yields", () => {
    expect(fit({ available: 299.7 })).toEqual({ shown: 2, squeeze: false, tag: null });
    expect(fit({ available: 299.4 })).toEqual({ shown: 1, squeeze: false, tag: null });
  });

  it("tries the first chip ellipsized when none fits whole", () => {
    expect(fit({ available: 120 })).toEqual({ shown: 1, squeeze: true, tag: null });
  });

  it("has nothing to try on a strip with no chips", () => {
    expect(fit({ slotRights: [], total: 0 })).toEqual({
      shown: 0,
      squeeze: false,
      tag: null
    });
  });

  // The measure pass renders the tag chip whole, and it stays whole until the
  // strip has nothing left to give — so however little room the strip has.
  it("starts a row's tag chip whole, whatever the strip has room for", () => {
    expect(fitRefChips(measure({}), true)).toEqual({
      shown: 2,
      squeeze: false,
      tag: "whole"
    });
    expect(fitRefChips(measure({ available: 0 }), true)).toEqual({
      shown: 1,
      squeeze: true,
      tag: "whole"
    });
    expect(fitRefChips(measure({ slotRights: [], total: 0 }), true)).toEqual({
      shown: 0,
      squeeze: false,
      tag: "whole"
    });
  });
});

describe("shedRefChip", () => {
  const ladder = (from: RefChipFit): RefChipFit[] => {
    const steps = [];
    let step: RefChipFit | null = from;
    while (step !== null) {
      steps.push(step);
      step = shedRefChip(step);
    }
    return steps;
  };

  it("folds whole chips first, then ellipsizes the last, then folds it", () => {
    expect(ladder({ shown: 2, squeeze: false, tag: null })).toEqual([
      { shown: 2, squeeze: false, tag: null },
      { shown: 1, squeeze: false, tag: null },
      { shown: 1, squeeze: true, tag: null },
      { shown: 0, squeeze: false, tag: null }
    ]);
  });

  it("walks the tag chip down only once every branch chip has folded", () => {
    expect(ladder({ shown: 2, squeeze: false, tag: "whole" })).toEqual([
      { shown: 2, squeeze: false, tag: "whole" },
      { shown: 1, squeeze: false, tag: "whole" },
      { shown: 1, squeeze: true, tag: "whole" },
      { shown: 0, squeeze: false, tag: "whole" },
      { shown: 0, squeeze: false, tag: "squeezed" },
      { shown: 0, squeeze: false, tag: "glyph" }
    ]);
  });
});
