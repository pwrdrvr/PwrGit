import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * The refs browser's actions column is one constant, not a measurement.
 *
 * Every row of `.refs-table` is its own grid, so a last column of
 * `minmax(210px, auto)` resolved per row: a local branch with four buttons came
 * out 73px wider than a remote row with two, and its Upstream started 43px
 * left of the UPSTREAM header. `getBoundingClientRect` cannot run in jsdom, so
 * this pins the cause instead: header and rows must read the same token, and
 * no refs grid may size its last column by its content.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

/** Every `grid-template-columns` value declared in a rule whose selector list
 *  mentions one of the refs table classes. */
function refsGridTemplates(): { selector: string; template: string }[] {
  const out: { selector: string; template: string }[] = [];
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (block[1] ?? "").trim();
    if (!/\.refs-(table__(header|row)|pr-table__row|tag-table__row)/.test(selector)) continue;
    const found = /grid-template-columns:\s*([^;]+);/.exec(block[2] ?? "");
    if (found?.[1] !== undefined) {
      out.push({ selector, template: found[1].replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

it("declares the actions width once, on the browser", () => {
  expect(css).toMatch(/\.refs-browser\s*\{[^}]*--refs-actions-w:\s*\d+px/);
});

it("gives the branch and pull-request grids the same fixed last column", () => {
  const templates = refsGridTemplates();
  const branch = templates.find((t) => t.selector.includes(".refs-table__row") && t.template.includes("105px"));
  const pr = templates.find((t) => t.selector.includes(".refs-pr-table__row") && t.template.includes("56px"));
  expect(branch?.template.endsWith("var(--refs-actions-w)")).toBe(true);
  expect(pr?.template.endsWith("var(--refs-actions-w)")).toBe(true);
});

// The narrow steps are container queries on the browser's body (zoom takes
// the 940px window well below the tables' minimums). A step either keeps the
// actions in their column, at the token, or stacks them on a line of their
// own and declares no actions column at all.
it("gives the tag grid the same token", () => {
  const tags = refsGridTemplates().filter((t) => t.selector.includes(".refs-tag-table__row"));
  expect(tags.length).toBeGreaterThan(0);
  for (const { template } of tags) {
    const tracks = template.match(/minmax\([^)]*\)|var\([^)]*\)|[\d.]+px/g) ?? [];
    if (tracks.length > 2) expect(template.endsWith("var(--refs-actions-w)")).toBe(true);
    else expect(template).not.toContain("--refs-actions-w");
  }
});

it("never sizes a refs grid's last column by its content", () => {
  for (const { selector, template } of refsGridTemplates()) {
    expect(template, selector).not.toMatch(/minmax\([^)]*,\s*auto\)\s*$/);
    expect(template, selector).not.toMatch(/(^|\s)auto\s*$/);
  }
});
