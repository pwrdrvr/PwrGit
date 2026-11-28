import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isShallowUnsupportedError,
  MAX_HISTORY_DEPTH,
  parseHistoryDepth
} from "./shallow-history";

describe("parseHistoryDepth", () => {
  // Rule: a count reaches Git only when it is exactly the whole number the
  // user wrote, from 1 to MAX_HISTORY_DEPTH. Everything else is refused, never
  // rounded, clamped or reinterpreted.
  it("accepts exactly the whole numbers 1..MAX, as numbers or plain digits", () => {
    fc.assert(
      fc.property(fc.integer({ min: -MAX_HISTORY_DEPTH * 2, max: MAX_HISTORY_DEPTH * 2 }), (n) => {
        const expected = n >= 1 && n <= MAX_HISTORY_DEPTH ? n : null;
        expect(parseHistoryDepth(n)).toBe(expected);
        expect(parseHistoryDepth(String(n))).toBe(expected);
      })
    );
  });

  it("refuses any string that is not plain digits, even when Number() would parse it", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const parsed = parseHistoryDepth(text);
        if (parsed !== null) {
          expect(text).toMatch(/^[0-9]+$/);
          expect(String(parsed)).toBe(String(Number(text)));
        }
      })
    );
    for (const text of ["1e3", "0x10", " 5", "5 ", "5.0", "+5", "-5", "", "0", "100001", "Infinity"]) {
      expect(parseHistoryDepth(text)).toBeNull();
    }
  });

  it("refuses non-integers and non-numbers", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (n) => {
        if (!Number.isInteger(n)) expect(parseHistoryDepth(n)).toBeNull();
      })
    );
    for (const value of [null, undefined, true, {}, [], [5], 5n]) {
      expect(parseHistoryDepth(value)).toBeNull();
    }
  });
});

describe("isShallowUnsupportedError", () => {
  it("recognises Git's own refusals and not ordinary failures", () => {
    expect(isShallowUnsupportedError("fatal: dumb http transport does not support shallow capabilities")).toBe(true);
    expect(isShallowUnsupportedError("fatal: Server does not support shallow clients")).toBe(true);
    expect(isShallowUnsupportedError("fatal: Server does not support --deepen")).toBe(true);
    expect(isShallowUnsupportedError("fatal: Authentication failed for 'https://example.com/'")).toBe(false);
    expect(isShallowUnsupportedError("fatal: repository 'x' not found")).toBe(false);
  });
});
