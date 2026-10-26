// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { foldChips, headingRowFits, steppedTooltip } from "./section-fit";

describe("foldChips", () => {
  const chips = [
    { rank: 1, text: "29 ahead" },
    { rank: 2, text: "32 behind" },
    { rank: 3, text: "322 gone" }
  ] as const;

  it("folds gone, then behind, then ahead", () => {
    expect(foldChips(chips)).toEqual([
      { step: 1, folded: ["322 gone"] },
      { step: 2, folded: ["32 behind", "322 gone"] },
      { step: 3, folded: ["29 ahead", "32 behind", "322 gone"] }
    ]);
  });

  it("draws no chip for a step that folds nothing present", () => {
    expect(foldChips([{ rank: 1, text: "3 ahead" }])).toEqual([
      { step: 3, folded: ["3 ahead"] }
    ]);
    expect(foldChips([])).toEqual([]);
  });
});

describe("headingRowFits", () => {
  const rect = (left: number, right: number): DOMRect =>
    ({ left, right, width: right - left, top: 0, bottom: 10 }) as DOMRect;
  function row(children: [number, number][]): HTMLElement {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => rect(0, 200);
    for (const [left, right] of children) {
      const child = document.createElement("span");
      child.getBoundingClientRect = () => rect(left, right);
      child.getClientRects = () => [rect(left, right)] as unknown as DOMRectList;
      el.append(child);
    }
    const hidden = document.createElement("span");
    hidden.getBoundingClientRect = () => rect(0, 900);
    hidden.getClientRects = () => [] as unknown as DOMRectList;
    el.append(hidden);
    document.body.append(el);
    return el;
  }

  it("fits while every laid-out item ends inside the box", () => {
    expect(headingRowFits(row([[0, 120], [124, 200]]))).toBe(true);
  });

  it("does not fit once a rigid item runs past it", () => {
    expect(headingRowFits(row([[0, 120], [124, 201]]))).toBe(false);
  });
});

describe("steppedTooltip", () => {
  it("opens only once the block has taken the step", () => {
    const tip = { show: vi.fn(), hide: vi.fn(), hideFrom: vi.fn() };
    const block = document.createElement("div");
    const head = document.createElement("button");
    block.append(head);
    const handlers = steppedTooltip(tip, "Branches · 533");
    const enter = () =>
      handlers.onMouseEnter({ currentTarget: head } as unknown as Parameters<
        typeof handlers.onMouseEnter
      >[0]);
    enter();
    expect(tip.show).not.toHaveBeenCalled();
    block.classList.add("fit-short", "fit-glyphs");
    enter();
    expect(tip.show).toHaveBeenCalledWith(head, "Branches · 533");
  });
});
