import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Locks the PR chip's draft bar against the pills it is drawn in.
 *
 * The bar is a short marker under the number, and the gap between the two is
 * the whole affordance. Without it the bar reads as an underline. It used to
 * be `bottom: 2px`, measured from the pill's bottom edge, while the label it
 * has to clear is vertically CENTERED. #86 made the sidebar's pill 2px shorter
 * than the base pill, and from then on the bar sat on the digits at every
 * sidebar notch. Measured in headless Chromium against the real stylesheet,
 * digits' ink -> bar top, "md":
 *
 *     base pill      18px / 9.5px text    1x +1px    2x +1.5px
 *     sidebar row    16px / 11px text     1x -1px    2x -0.5px   (overlap)
 *
 * The bar now hangs off the centerline by the label's own half-height, so the
 * gap follows the label wherever it goes. What varies instead is the room left
 * UNDER the bar, and that is what a shorter pill runs out of. So the last test
 * walks every pill height the stylesheet declares, at every sidebar notch.
 *
 * jsdom does not lay out CSS, so this asserts the arithmetic behind those
 * measurements. Change it in the same commit as any deliberate change to the
 * affordance.
 */

const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const appCss = strip(readFileSync(resolve(here, "app.css"), "utf8"));
const tokensCss = strip(readFileSync(resolve(here, "tokens.css"), "utf8"));

/** Every rule as [selectors, body], `@media` contents included. A selector
 *  list holds no brace or semicolon, so each match starts right after the
 *  previous rule's `}` (or an at-rule's `{` / `;`) without consuming it. */
const rules = [...appCss.matchAll(/([^@{};\s][^{};]*)\{([^{}]*)\}/g)].map(
  (m) => ({
    selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
    body: m[2]!
  })
);

/** One property of `selector`, the last declaration winning, as in the cascade. */
function declared(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    const found = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`).exec(rule.body);
    if (found) value = found[1]!.trim();
  }
  return value;
}

function px(value: string | undefined, label: string): number {
  const found = /^(-?\d*\.?\d+)px$/.exec(value ?? "");
  if (!found) throw new Error(`expected ${label} in px, got ${value}`);
  return Number(found[1]);
}

/** `calc(var(--x) + 5px)` -> 5, for a length derived from one custom property. */
function offsetFrom(value: string | undefined, token: string, label: string): number {
  const found = new RegExp(
    `^calc\\(var\\(${token}\\)\\s*([+-])\\s*(\\d*\\.?\\d+)px\\)$`
  ).exec(value ?? "");
  if (!found) throw new Error(`expected ${label} as calc(var(${token}) ± Npx), got ${value}`);
  return (found[1] === "-" ? -1 : 1) * Number(found[2]);
}

/** `translateY(-1px)` -> 1. The draft lift is always upward. */
function lift(selector: string): number {
  const found = /^translateY\((-?\d*\.?\d+)px\)$/.exec(declared(selector, "transform") ?? "");
  if (!found) throw new Error(`expected a translateY lift on ${selector}`);
  return -Number(found[1]);
}

const BAR = ".pr-chip__draft-bar";
const SIDEBAR_BAR = ".wt-row .pr-chip__draft-bar";
const CHIP = ".pr-chip";
const SIDEBAR_CHIP = ".wt-row .pr-chip";
const DRAFT_LABEL = ".pr-chip--draft .pr-chip__label";
const DRAFT_DOT = ".pr-chip--draft .pr-chip__dot";

/**
 * How far above the label box's bottom edge the digits' ink ends, antialiasing
 * included. Measured in headless Chromium with the bundled Geist Mono 600 at
 * `line-height: 1`: 1.25px at the sidebar's 9-13px, 0.75px at the base pill's
 * 9.5px, where the half-pixel size rounds the baseline down. The smaller one.
 */
const INK_ABOVE_LABEL_BOX_PX = 0.75;

/** Below about 1px the bar stops reading as its own marker. */
const MIN_INK_GAP_PX = 1;

/** Less than this under the bar and it reads as part of the pill's border. */
const MIN_ROOM_PX = 0.5;

/** The bar's `margin-top`, split into its em and px terms. */
function barOffset(): { em: number; px: number } {
  const value = declared(BAR, "margin-top");
  const found = /^calc\((\d*\.?\d+)em\s*([+-])\s*(\d*\.?\d+)px\)$/.exec(value ?? "");
  if (!found) throw new Error(`expected the bar offset as calc(Nem ± Npx), got ${value}`);
  return {
    em: Number(found[1]),
    px: (found[2] === "-" ? -1 : 1) * Number(found[3])
  };
}

/** Where the bar starts relative to the (lifted) label box's bottom edge. */
function barGapToLabelBox(): number {
  return barOffset().px + lift(DRAFT_LABEL);
}

describe("PR chip draft bar", () => {
  it("anchors the bar to the pill's centerline, not its bottom edge", () => {
    // `top` does nothing on a static box, and resolves against the wrong
    // containing block without a positioned chip.
    expect(declared(BAR, "position")).toBe("absolute");
    expect(declared(CHIP, "position")).toBe("relative");
    expect(declared(BAR, "top")).toBe("50%");
    // The defect: `bottom` measures from an edge the label is not placed
    // against, so the gap becomes a function of the pill's height.
    expect(declared(BAR, "bottom")).toBeUndefined();
    expect(declared(SIDEBAR_BAR, "bottom")).toBeUndefined();
    expect(declared(SIDEBAR_BAR, "top")).toBeUndefined();
    expect(declared(SIDEBAR_BAR, "margin-top")).toBeUndefined();
  });

  it("offsets the bar by the label's half-height, lift and gap", () => {
    // The label box is `line-height` em tall and centered, so its bottom edge
    // is half that below the centerline. That is the em term, and it is what
    // makes the offset follow the label's size in every context.
    const lineHeight = /\/\s*(\d*\.?\d+)\s/.exec(declared(CHIP, "font") ?? "");
    expect(lineHeight, "the chip's font shorthand declares a line-height").not.toBeNull();
    expect(barOffset().em).toBe(Number(lineHeight![1]) / 2);

    // The dot rides with the label, or the offset is right for only one.
    expect(lift(DRAFT_DOT)).toBe(lift(DRAFT_LABEL));

    // The bar starts below the label box, far enough to clear the ink.
    expect(barGapToLabelBox()).toBeGreaterThanOrEqual(0);
    expect(barGapToLabelBox() + INK_ABOVE_LABEL_BOX_PX).toBeGreaterThanOrEqual(
      MIN_INK_GAP_PX
    );
  });

  it("leaves the bar room inside every pill, at every sidebar notch", () => {
    const border = px(declared(CHIP, "border")?.split(/\s+/)[0], "chip border");
    const baseFont = /(\d*\.?\d+)px\s*\//.exec(declared(CHIP, "font") ?? "");
    if (!baseFont) throw new Error("expected a px size in the chip's font shorthand");

    // `--sidebar-title-size` at the default and every notch; the chip tier is
    // derived from it, and the sidebar pill from the chip tier.
    const titles = [...tokensCss.matchAll(/--sidebar-title-size:\s*(\d*\.?\d+)px;/g)].map(
      (m) => Number(m[1])
    );
    expect(titles.length, "default + four notches").toBe(5);
    const chipBelowTitle = offsetFrom(
      /--sidebar-chip-size:\s*([^;]+);/.exec(tokensCss)?.[1]?.trim(),
      "--sidebar-title-size",
      "--sidebar-chip-size"
    );
    expect(declared(SIDEBAR_CHIP, "font-size")).toBe("var(--sidebar-chip-size)");
    const sidebarPillOverType = offsetFrom(
      declared(SIDEBAR_CHIP, "height"),
      "--sidebar-chip-size",
      "sidebar pill height"
    );

    const pills = [
      {
        name: "base pill",
        height: px(declared(CHIP, "height"), "base pill height"),
        font: Number(baseFont[1]),
        bar: px(declared(BAR, "height"), "bar height")
      },
      ...titles.map((title) => {
        const font = title + chipBelowTitle;
        return {
          name: `sidebar pill, ${title}px titles`,
          height: font + sidebarPillOverType,
          font,
          // Without its own override the sidebar draws the shared bar, as the
          // cascade would; that is the case this check exists to reject.
          bar: px(
            declared(SIDEBAR_BAR, "height") ?? declared(BAR, "height"),
            "sidebar bar height"
          )
        };
      })
    ];

    const { em, px: offsetPx } = barOffset();
    for (const pill of pills) {
      const barTop = em * pill.font + offsetPx;
      const innerHalf = pill.height / 2 - border;
      expect(innerHalf - (barTop + pill.bar), `${pill.name}: room under the bar`)
        .toBeGreaterThanOrEqual(MIN_ROOM_PX);
    }

    // A new context that resizes the pill or its type has to join the list
    // above, so fail when the stylesheet grows one this test does not know.
    const sized = new Set<string>();
    for (const rule of rules) {
      if (!/(?:^|;)\s*(?:height|font|font-size)\s*:/.test(rule.body)) continue;
      for (const selector of rule.selectors) {
        if (/(?:^|\s|>)\.pr-chip$/.test(selector)) sized.add(selector);
      }
    }
    expect([...sized].sort()).toEqual([CHIP, SIDEBAR_CHIP]);
  });
});
