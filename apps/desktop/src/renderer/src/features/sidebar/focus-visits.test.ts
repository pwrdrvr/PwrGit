import { describe, expect, it } from "vitest";
import { parseFocusVisits, recordFocusVisit } from "./focus-visits";

describe("focus visit persistence", () => {
  it("accepts only finite non-negative timestamps", () => {
    expect(
      parseFocusVisits(
        '{"current":42,"negative":-1,"text":"today","infinite":1e999}'
      )
    ).toEqual({ current: 42 });
  });

  it("falls back safely for old or malformed values", () => {
    expect(parseFocusVisits(null)).toEqual({});
    expect(parseFocusVisits("not json")).toEqual({});
    expect(parseFocusVisits("[]")).toEqual({});
  });

  it("keeps the newest bounded history and refreshes an existing visit", () => {
    const visits = recordFocusVisit({ old: 1, middle: 2 }, "new", 3, 2);
    expect(visits).toEqual({ new: 3, middle: 2 });
    expect(recordFocusVisit(visits, "middle", 4, 2)).toEqual({
      middle: 4,
      new: 3
    });
  });

  it("ignores invalid visits before they reach storage", () => {
    const visits = { current: 42 };
    expect(recordFocusVisit(visits, "", 50)).toBe(visits);
    expect(recordFocusVisit(visits, "next", Number.NaN)).toBe(visits);
  });
});
