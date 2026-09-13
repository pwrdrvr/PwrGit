import { describe, expect, it } from "vitest";
import {
  STEP_ORDER,
  nextStep,
  previousStep,
  railIndexForStep,
  railLabel,
  type WizardStep
} from "./steps";

const NO_ANSWERS = {
  authorName: null,
  forgeSummary: null,
  roots: [] as readonly string[]
};

describe("railIndexForStep", () => {
  it("keeps Welcome off the rail", () => {
    expect(railIndexForStep("welcome")).toBe(-1);
  });

  it("puts all three folder surfaces on one rail step", () => {
    expect(railIndexForStep("folders-explain")).toBe(2);
    expect(railIndexForStep("folders-pick")).toBe(2);
    expect(railIndexForStep("folders-scan")).toBe(2);
  });

  it("covers every step in the order", () => {
    for (const step of STEP_ORDER) {
      expect(railIndexForStep(step)).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("navigation", () => {
  it("walks Welcome → Done and back without skipping a surface", () => {
    const forward: WizardStep[] = ["welcome"];
    let cursor: WizardStep | null = "welcome";
    while ((cursor = nextStep(cursor)) !== null) forward.push(cursor);
    expect(forward).toEqual([...STEP_ORDER]);

    const backward: WizardStep[] = ["done"];
    let back: WizardStep | null = "done";
    while ((back = previousStep(back)) !== null) backward.push(back);
    expect(backward).toEqual([...STEP_ORDER].reverse());
  });

  it("has no step after Done and none before Welcome", () => {
    expect(nextStep("done")).toBeNull();
    expect(previousStep("welcome")).toBeNull();
  });
});

/** The rail is the review surface — this is what lets Done carry no summary. */
describe("railLabel", () => {
  it("shows the step's own name until you are past it", () => {
    expect(railLabel(0, 0, { ...NO_ANSWERS, authorName: "Dana" })).toBe(
      "Identity"
    );
    expect(railLabel(0, 1, { ...NO_ANSWERS, authorName: "Dana" })).toBe("Dana");
  });

  it("falls back to the step name when the answer is empty", () => {
    expect(railLabel(0, 3, NO_ANSWERS)).toBe("Identity");
  });

  it("summarises roots as first +n, and says None for none", () => {
    expect(railLabel(2, 3, { ...NO_ANSWERS, roots: ["~/code"] })).toBe("~/code");
    expect(
      railLabel(2, 3, { ...NO_ANSWERS, roots: ["~/code", "~/work", "~/x"] })
    ).toBe("~/code +2");
    expect(railLabel(2, 3, { ...NO_ANSWERS, roots: [] })).toBe("None");
  });

  it("never relabels Review", () => {
    expect(railLabel(3, 3, { ...NO_ANSWERS, authorName: "Dana" })).toBe(
      "Review"
    );
  });
});
