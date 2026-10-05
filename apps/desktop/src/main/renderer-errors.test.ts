import { describe, expect, it, vi } from "vitest";
import {
  createRendererErrorLog,
  formatRendererErrorReport,
  sanitizeRendererErrorReport
} from "./renderer-errors";

const REPORT = {
  source: "react-uncaught",
  message: "Error: lightbox exploded",
  stack: "Error: lightbox exploded\n    at ImageLightbox (ImageLightbox.tsx:120:9)",
  componentStack: "\n    at ImageLightbox\n    at DiffViewer\n    at DiffPane",
  view: "#logs"
} as const;

describe("sanitizeRendererErrorReport", () => {
  it("keeps a well-formed report", () => {
    expect(sanitizeRendererErrorReport(REPORT)).toEqual(REPORT);
  });

  it("rejects what is not a report", () => {
    expect(sanitizeRendererErrorReport(null)).toBeNull();
    expect(sanitizeRendererErrorReport("boom")).toBeNull();
    expect(sanitizeRendererErrorReport({ ...REPORT, source: "made-up" })).toBeNull();
    expect(sanitizeRendererErrorReport({ ...REPORT, message: 42 })).toBeNull();
  });

  it("drops fields of the wrong type and clips oversized ones", () => {
    const clean = sanitizeRendererErrorReport({
      source: "window-error",
      message: "x".repeat(5_000),
      stack: { not: "a string" },
      componentStack: "y".repeat(10_000)
    });
    expect(clean?.stack).toBeUndefined();
    expect(clean?.message).toMatch(/^x{1000}… \(4000 more chars\)$/);
    expect(clean?.componentStack?.length).toBeLessThan(4_100);
  });
});

describe("formatRendererErrorReport", () => {
  it("names the source, sender and window, then both stacks — without printing the message twice", () => {
    const line = formatRendererErrorReport(REPORT, 3);
    expect(line).toBe(
      "renderer error (react-uncaught wc=3 view=#logs): Error: lightbox exploded\n" +
        "    at ImageLightbox (ImageLightbox.tsx:120:9)\n" +
        "component stack:\n    at ImageLightbox\n    at DiffViewer\n    at DiffPane"
    );
  });

  it("does not repeat a clipped message ahead of the stack that carries it", () => {
    const long = "x".repeat(5_000);
    const clean = sanitizeRendererErrorReport({
      source: "react-caught",
      message: `Error: ${long}`,
      stack: `Error: ${long}\n    at Thrower`
    })!;
    const line = formatRendererErrorReport(clean, 1);
    expect(line.startsWith("renderer error (react-caught wc=1): Error: xxx")).toBe(true);
    expect(line).not.toContain("more chars)\nError:");
  });

  it("keeps the message when the stack does not carry it", () => {
    const line = formatRendererErrorReport(
      { source: "unhandled-rejection", message: '{"code":1}' },
      undefined
    );
    expect(line).toBe('renderer error (unhandled-rejection wc=?): {"code":1}');
  });
});

describe("createRendererErrorLog", () => {
  const report = sanitizeRendererErrorReport(REPORT)!;

  it("writes reports to the log under the renderer scope", () => {
    const log = vi.fn();
    createRendererErrorLog({ log, now: () => 0 }).report(report, 1);
    expect(log).toHaveBeenCalledWith(
      "error",
      "renderer",
      expect.stringContaining("lightbox exploded")
    );
  });

  it("bounds a render loop: a burst, then a trickle, then a count of what it dropped", () => {
    const log = vi.fn();
    let now = 0;
    const errors = createRendererErrorLog({ log, now: () => now });

    const accepted = Array.from({ length: 500 }, () => errors.report(report, 7));
    expect(accepted.filter(Boolean)).toHaveLength(10);
    // Ten reports, then one line the moment dropping starts — written then,
    // because a later report that carries the count may never come.
    expect(log).toHaveBeenCalledTimes(11);
    expect(log.mock.calls[10]![2]).toMatch(/^rate limit reached for wc=7; dropping/);

    // One more is earned every 6s; the first one through says what was lost.
    now = 6_000;
    expect(errors.report(report, 7)).toBe(true);
    expect(log).toHaveBeenCalledTimes(13);
    expect(log.mock.calls[11]![2]).toMatch(/^suppressed 490 renderer error report\(s\) from wc=7/);
    expect(errors.report(report, 7)).toBe(false);
  });

  it("budgets each window separately, so one loop cannot silence another", () => {
    const log = vi.fn();
    const errors = createRendererErrorLog({ log, now: () => 0 });
    for (let i = 0; i < 50; i += 1) errors.report(report, 1);
    expect(errors.report(report, 2)).toBe(true);
  });

  it("evicts the sender quiet longest, not a window that is still reporting", () => {
    const log = vi.fn();
    const errors = createRendererErrorLog({ log, now: () => 0 });
    // wc=1 spends its budget first, then 31 other windows report once.
    for (let i = 0; i < 20; i += 1) errors.report(report, 1);
    for (let wc = 2; wc <= 32; wc += 1) errors.report(report, wc);
    // wc=1 reports again (still dropped), so it is no longer the oldest.
    expect(errors.report(report, 1)).toBe(false);
    // A 33rd window forces an eviction — of wc=2, not wc=1.
    errors.report(report, 33);
    expect(errors.report(report, 1)).toBe(false);
  });

  it("refills to the burst, never beyond it", () => {
    const log = vi.fn();
    let now = 0;
    const errors = createRendererErrorLog({ log, now: () => now });
    errors.report(report, 1);
    now = 60 * 60 * 1000;
    const accepted = Array.from({ length: 20 }, () => errors.report(report, 1));
    expect(accepted.filter(Boolean)).toHaveLength(10);
  });
});
