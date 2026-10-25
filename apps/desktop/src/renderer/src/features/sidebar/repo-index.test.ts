import { describe, expect, it } from "vitest";
import {
  jumpScrollPlan,
  repoIndexFit,
  repoIndexMenuHint,
  sameSpy,
  spacerIsOffscreen,
  spyRepos,
  typeaheadIndex,
  SIDEBAR_MIN_WIDTH
} from "./repo-index";

describe("repoIndexFit", () => {
  const base = { enabled: true, repoCount: 14, minWidth: 69 };

  it("takes every pixel past the tree's floor once that clears the minimum", () => {
    expect(repoIndexFit({ ...base, sidebarWidth: 320 })).toEqual({
      shown: true,
      maxWidth: 80
    });
    expect(repoIndexFit({ ...base, sidebarWidth: 430 })).toEqual({
      shown: true,
      maxWidth: 190
    });
  });

  it("steps out entirely below floor + minimum, never squeezing the tree", () => {
    expect(repoIndexFit({ ...base, sidebarWidth: SIDEBAR_MIN_WIDTH + 69 }).shown).toBe(true);
    expect(repoIndexFit({ ...base, sidebarWidth: SIDEBAR_MIN_WIDTH + 68 })).toEqual({
      shown: false,
      reason: "narrow"
    });
    expect(repoIndexFit({ ...base, sidebarWidth: 240 })).toEqual({
      shown: false,
      reason: "narrow"
    });
  });

  it("follows the measured minimum, so the type axis moves the step", () => {
    // A larger text notch measures a wider 7ch, and the index appears later.
    expect(repoIndexFit({ ...base, minWidth: 84, sidebarWidth: 320 }).shown).toBe(false);
    expect(repoIndexFit({ ...base, minWidth: 84, sidebarWidth: 324 }).shown).toBe(true);
  });

  it("does not flash before anything is measured", () => {
    expect(repoIndexFit({ ...base, minWidth: 0, sidebarWidth: 500 })).toEqual({
      shown: false,
      reason: "narrow"
    });
  });

  it("is off when turned off, and has nothing to say for one repository", () => {
    expect(repoIndexFit({ ...base, enabled: false, sidebarWidth: 500 })).toEqual({
      shown: false,
      reason: "off"
    });
    expect(repoIndexFit({ ...base, repoCount: 1, sidebarWidth: 500 })).toEqual({
      shown: false,
      reason: "few"
    });
  });

  it("explains a hidden index in the menu, but not one the user turned off", () => {
    expect(repoIndexMenuHint({ shown: false, reason: "narrow" })).toBe(
      "Widen the sidebar to show it"
    );
    expect(repoIndexMenuHint({ shown: false, reason: "few" })).toBe(
      "Shown with two or more repositories"
    );
    expect(repoIndexMenuHint({ shown: false, reason: "off" })).toBeUndefined();
    expect(repoIndexMenuHint({ shown: true, maxWidth: 80 })).toBeUndefined();
  });
});

describe("spyRepos", () => {
  // atlas collapsed (26px), beacon expanded (300px), cinder, delta collapsed.
  const blocks = (scroll: number) =>
    [
      { id: "atlas", top: 0, bottom: 26 },
      { id: "beacon", top: 26, bottom: 326 },
      { id: "cinder", top: 326, bottom: 352 },
      { id: "delta", top: 352, bottom: 378 }
    ].map((b) => ({ ...b, top: b.top - scroll, bottom: b.bottom - scroll }));

  it("names the block whose header is stuck at the top", () => {
    expect(spyRepos(blocks(0), 200).current).toBe("atlas");
    expect(spyRepos(blocks(30), 200).current).toBe("beacon");
    // Deep inside a tall block: still that block, not the "most visible".
    expect(spyRepos(blocks(250), 200).current).toBe("beacon");
    expect(spyRepos(blocks(326), 200).current).toBe("cinder");
  });

  it("lists every block on screen, and none hidden above the line", () => {
    expect(spyRepos(blocks(0), 200).inView).toEqual(["atlas", "beacon"]);
    expect(spyRepos(blocks(250), 200).inView).toEqual(["beacon", "cinder", "delta"]);
  });

  it("reads under the sticky folder heading when grouped", () => {
    // A block that ends under the 28px heading is not the current one.
    const grouped = blocks(0).map((b) => ({ ...b, top: b.top + 28 - 50, bottom: b.bottom + 28 - 50 }));
    expect(spyRepos(grouped, 200, 28).current).toBe("beacon");
    expect(spyRepos(grouped, 200, 28).inView[0]).toBe("beacon");
  });

  it("falls back to the last block past the end, and to null with none", () => {
    expect(spyRepos(blocks(1000), 200).current).toBe("delta");
    expect(spyRepos([], 200)).toEqual({ current: null, inView: [] });
  });

  it("compares by value so a scroll that changes nothing renders nothing", () => {
    expect(sameSpy(spyRepos(blocks(30), 200), spyRepos(blocks(31), 200))).toBe(true);
    expect(sameSpy(spyRepos(blocks(0), 200), spyRepos(blocks(30), 200))).toBe(false);
  });
});

describe("jumpScrollPlan", () => {
  it("puts the block's top at the top of the scrollport", () => {
    expect(
      jumpScrollPlan({
        scrollTop: 100,
        blockTop: 240,
        line: 0,
        scrollHeight: 2000,
        clientHeight: 400,
        spacerHeight: 0
      })
    ).toEqual({ scrollTop: 340, spacerHeight: 0 });
  });

  it("lands under the sticky folder heading when grouped", () => {
    expect(
      jumpScrollPlan({
        scrollTop: 0,
        blockTop: 300,
        line: 28,
        scrollHeight: 2000,
        clientHeight: 400,
        spacerHeight: 0
      }).scrollTop
    ).toBe(272);
  });

  it("scrolls up as well as down", () => {
    expect(
      jumpScrollPlan({
        scrollTop: 900,
        blockTop: -500,
        line: 0,
        scrollHeight: 2000,
        clientHeight: 400,
        spacerHeight: 0
      }).scrollTop
    ).toBe(400);
  });

  it("grows the blank tail by exactly what a block near the end is short", () => {
    // Max scroll is 1600; the block wants 1750.
    expect(
      jumpScrollPlan({
        scrollTop: 1500,
        blockTop: 250,
        line: 0,
        scrollHeight: 2000,
        clientHeight: 400,
        spacerHeight: 0
      })
    ).toEqual({ scrollTop: 1750, spacerHeight: 150 });
    // A tail already there is grown, not replaced.
    expect(
      jumpScrollPlan({
        scrollTop: 1600,
        blockTop: 100,
        line: 0,
        scrollHeight: 2000,
        clientHeight: 400,
        spacerHeight: 40
      }).spacerHeight
    ).toBe(140);
  });

  it("drops the tail only once it is entirely off screen", () => {
    expect(spacerIsOffscreen(500, 400)).toBe(true);
    expect(spacerIsOffscreen(400, 400)).toBe(true);
    expect(spacerIsOffscreen(399, 400)).toBe(false);
  });
});

describe("typeaheadIndex", () => {
  const names = ["atlas-api", "beacon-web", "cinder", "cobalt", "delta-svc"];

  it("moves to the next name starting with a letter, wrapping", () => {
    expect(typeaheadIndex(names, 0, "c")).toBe(2);
    expect(typeaheadIndex(names, 2, "c")).toBe(3);
    expect(typeaheadIndex(names, 3, "c")).toBe(2);
    expect(typeaheadIndex(names, 4, "a")).toBe(0);
  });

  it("refines on more letters without leaving a name that still matches", () => {
    expect(typeaheadIndex(names, 2, "ci")).toBe(2);
    expect(typeaheadIndex(names, 2, "co")).toBe(3);
  });

  it("cycles on a repeated letter, ignores case, and says when nothing matches", () => {
    expect(typeaheadIndex(names, 2, "cc")).toBe(3);
    expect(typeaheadIndex(names, 0, "D")).toBe(4);
    expect(typeaheadIndex(names, 0, "z")).toBe(-1);
    expect(typeaheadIndex([], 0, "a")).toBe(-1);
  });
});
