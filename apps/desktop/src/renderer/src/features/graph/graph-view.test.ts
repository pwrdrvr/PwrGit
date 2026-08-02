import { describe, expect, it } from "vitest";
import { longWhen, shortWhen } from "./graph-view";

describe("shortWhen", () => {
  const base = new Date("2026-06-01T00:00:00Z").getTime();
  it("formats recent and older times", () => {
    expect(shortWhen("2026-06-01T00:00:00Z", base)).toBe("just now");
    expect(shortWhen("2026-05-31T22:00:00Z", base)).toBe("2h");
    expect(shortWhen("2026-05-31T21:47:00Z", base)).toBe("2h 13m");
    expect(shortWhen("2026-05-27T00:00:00Z", base)).toBe("5d");
    expect(shortWhen("2026-05-18T00:00:00Z", base)).toBe("2w");
  });

  it("spells out the age used in the commit context card", () => {
    expect(longWhen("2026-05-31T22:47:00Z", base)).toBe("1h 13m ago");
    expect(longWhen("2026-05-31T23:59:00Z", base)).toBe("1 minute ago");
  });
});
