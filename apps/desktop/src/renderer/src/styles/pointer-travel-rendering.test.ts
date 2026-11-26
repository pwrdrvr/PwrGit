import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const appCss = strip(readFileSync(join(here, "app.css"), "utf8"));
const contributionsCss = strip(
  readFileSync(
    resolve(here, "../features/contributions/contributions.css"),
    "utf8"
  )
);
const stacksCss = strip(
  readFileSync(resolve(here, "../features/stacks/stacks.css"), "utf8")
);
const allCss = `${appCss}\n${contributionsCss}\n${stacksCss}`;

type Rule = { selectors: string[]; body: string };

function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  let depth = 0;
  let start = 0;
  const stack: { prelude: string; open: number }[] = [];
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      stack.push({ prelude: css.slice(start, i).trim(), open: i + 1 });
      depth++;
      start = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      depth--;
      if (top !== undefined) {
        const body = css.slice(top.open, i);
        if (!body.includes("{") && !top.prelude.startsWith("@")) {
          out.push({
            selectors: top.prelude
              .split(",")
              .map((s) => s.trim().replace(/\s+/g, " ")),
            body
          });
        }
      }
      start = i + 1;
    } else if (ch === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return out;
}

const RULES = parseRules(allCss);

function declarationsFor(selector: string): string {
  const matches = RULES.filter((r) => r.selectors.includes(selector));
  expect(matches.length, `expected rule for ${selector}`).toBeGreaterThan(0);
  return matches.map((r) => r.body).join(";");
}

const POINTER_TRAVEL_PAINT_SELECTORS = [
  ".repo-row",
  ".wt-row",
  ".pr-chip",
  ".kebab__btn",
  ".pin",
  ".wt-refresh",
  ".sidebar-toolbar__btn",
  ".sidebar-toolbar__split",
  ".lens-chip",
  ".sidebar-options",
  ".profile-chip",
  ".titlebar-jump",
  ".history-nav__chip",
  ".titlebar__pathchip",
  ".titlebar__branch",
  ".contributions-nav",
  ".graph-row",
  ".commit-row",
  ".commit-sha-chip",
  ".graph-locate",
  ".graph-branches",
  ".pane-resizer::after"
] as const;

const HOVER_REVEAL_CONTROLS = [
  ".repo-row__handle",
  ".repo-row__menu",
  ".wt-row__handle",
  ".wt-row__hoveracts",
  ".wt-row .kebab.wt-row__menu"
] as const;

describe("pointer-travel rendering contract", () => {
  it("avoids non-composited hover paint transitions on pointer-travel surfaces", () => {
    for (const selector of POINTER_TRAVEL_PAINT_SELECTORS) {
      const body = declarationsFor(selector);
      expect(
        body,
        `${selector} must not run a main-thread paint transition on hover`
      ).not.toMatch(/(?:^|;)\s*transition\s*:/);
    }
  });

  it("keeps hover-revealed row controls layer-stable without opacity transitions", () => {
    for (const selector of HOVER_REVEAL_CONTROLS) {
      const body = declarationsFor(selector);
      expect(
        body,
        `${selector} must not animate opacity on hover`
      ).not.toMatch(/(?:^|;)\s*transition\s*:/);
      expect(
        body,
        `${selector} must hold a steady stacking context via isolation: isolate`
      ).toMatch(/(?:^|;)\s*isolation\s*:\s*isolate\b/);
    }
  });

  it("hides .wt-age on row hover via visibility rather than creating/destroying an opacity layer", () => {
    const hoverHide = declarationsFor(".wt-row:hover .wt-age");
    expect(hoverHide).toMatch(/(?:^|;)\s*visibility\s*:\s*hidden\b/);
    expect(hoverHide).not.toMatch(/(?:^|;)\s*opacity\s*:\s*0\b/);

    const focusRestore = declarationsFor(
      ".wt-row:has(.pr-chip:focus-visible) .wt-age"
    );
    expect(focusRestore).toMatch(/(?:^|;)\s*visibility\s*:\s*visible\b/);
    expect(focusRestore).not.toMatch(/(?:^|;)\s*opacity\s*:\s*1\b/);
  });

  it("contains plain tooltips inside a strict viewport overlay layer above interactive popovers", () => {
    const parseZIndex = (selector: string): number => {
      const match = declarationsFor(selector).match(
        /(?:^|;)\s*z-index\s*:\s*(\d+)\b/
      );
      expect(match, `expected numeric z-index on ${selector}`).not.toBeNull();
      return Number(match![1]);
    };

    const layer = declarationsFor(".viewport-tooltip-layer");
    expect(layer).toMatch(/(?:^|;)\s*position\s*:\s*fixed\b/);
    expect(layer).toMatch(/(?:^|;)\s*inset\s*:\s*0\b/);
    expect(layer).toMatch(/(?:^|;)\s*pointer-events\s*:\s*none\b/);
    expect(layer).toMatch(/(?:^|;)\s*contain\s*:\s*strict\b/);

    const tooltip = declarationsFor(".viewport-tooltip");
    expect(tooltip).toMatch(/(?:^|;)\s*contain\s*:\s*layout\s+style\b/);

    const layerZ = parseZIndex(".viewport-tooltip-layer");
    const tooltipZ = parseZIndex(".viewport-tooltip");
    for (const overlay of [
      ".commit-context-card",
      ".pr-status-card",
      ".person-card",
      ".remote-activity-popover",
      ".removal-toast",
      ".stack-popover"
    ]) {
      const overlayZ = parseZIndex(overlay);
      expect(
        layerZ,
        `.viewport-tooltip-layer z-index (${layerZ}) must exceed ${overlay} (${overlayZ})`
      ).toBeGreaterThan(overlayZ);
      expect(
        tooltipZ,
        `.viewport-tooltip z-index (${tooltipZ}) must exceed ${overlay} (${overlayZ})`
      ).toBeGreaterThan(overlayZ);
    }
  });
});
