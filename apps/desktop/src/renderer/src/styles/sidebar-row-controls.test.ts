import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * A control drawn inside a sidebar row must be smaller than the row.
 *
 * `.wt-row` and `.repo-row` carry their state on a 1px border — "selected" is
 * that border, and SC 1.4.11 is what makes it a border rather than the tint
 * behind it. A row's inner box is only about 24px, so a control that is also
 * 24px and vertically centred reaches that border from the inside, and
 * anything it paints there paints the state out. The kebab did exactly that:
 * a `--border-subtle` hairline at rest and an opaque `--bg-hover-strong` fill
 * on hover, so pointing at it erased the outline of the row it belongs to.
 *
 * The star beside it is the same 24px box over the same border and always was.
 * It escaped only because its fill is `--accent-soft` — 12% accent, 88%
 * transparent — over a transparent border, so the outline shows through. That
 * is a property of the palette, not of the layout, which is why this test
 * measures the box rather than trusting how it happens to be painted.
 *
 * Both halves are asserted together on purpose: shrinking the drawn box is
 * only correct while the pointer target stays 24px (SC 2.5.8), and the two
 * live in different rules a hundred lines apart.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appCss = readFileSync(resolve(here, "app.css"), "utf8");

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector list contains `selector`. */
function rule(selector: string): string {
  const source = strip(appCss);
  const pattern = new RegExp(
    `(^|[,}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(,[^{}]*)?\\{([^}]*)\\}`,
    "m"
  );
  const found = pattern.exec(source);
  if (found === null) throw new Error(`missing rule: ${selector}`);
  return found[3] ?? "";
}

function px(declarations: string, property: string): number {
  const found = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(\\d+)px`, "m").exec(
    declarations
  );
  if (found === null) throw new Error(`no ${property} in: ${declarations.trim()}`);
  return Number(found[1]);
}

it("draws the row kebab smaller than the row whose border it would cover", () => {
  const shipped = px(rule(".kebab__btn"), "height");
  const inRow = px(rule(".wt-row .kebab__btn"), "height");
  // 24px is the control's own size, and also roughly a worktree row's inner
  // height — which is the coincidence this override exists to break.
  expect(shipped).toBe(24);
  expect(inRow).toBeLessThan(shipped);
  // Two pixels of row on each side is the point; one is what "touching" looked
  // like the first time.
  expect(shipped - inRow).toBeGreaterThanOrEqual(4);
  expect(px(rule(".wt-row .kebab__btn"), "width")).toBe(inRow);
});

it("clears the button padding the glyph would otherwise be scaled by", () => {
  // The half of this fix that is easiest to lose. `.kebab__btn` inherits the
  // user agent's `padding: 1px 6px`, so the content box is 12px narrower than
  // the button — and an svg with the default `preserveAspectRatio` scales by
  // the narrower axis, not by its own width attribute. At 18px that padding
  // leaves a 4px content box and draws 3.1px of ink out of an 18px glyph.
  // `.pin` has always set `padding: 0` for the same reason; this is the rule
  // that brings the kebab in line with it.
  expect(rule(".wt-row .kebab__btn")).toMatch(/padding:\s*0(;|\s|$)/);
});

it("keeps the 24px pointer target the shrink would otherwise cost", () => {
  // The house answer for a control that must be drawn under 24px: a positioned
  // ::after out of flow, which is what the browser hit-tests. Shared with
  // `.wt-selbar__btn` and `.wt-section__toggle`, so this asserts membership of
  // that rule rather than a second copy of it.
  const hit = rule(".wt-row .kebab__btn::after");
  expect(px(hit, "min-width")).toBeGreaterThanOrEqual(24);
  expect(px(hit, "min-height")).toBeGreaterThanOrEqual(24);
  expect(hit).toMatch(/position:\s*absolute/);
  // The ::after can only anchor to the button if the button is positioned.
  expect(rule(".wt-row .kebab__btn")).toMatch(/position:\s*relative/);
});
