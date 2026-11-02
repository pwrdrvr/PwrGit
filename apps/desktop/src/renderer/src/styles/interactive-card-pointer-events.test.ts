import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An interactive `useViewportTooltip` card has controls in it, so it must take
 * the pointer. `.viewport-tooltip` is `pointer-events: none` (a plain tooltip
 * must never catch the pointer), and the Changes rail's "Why?" card carried
 * that class with nothing turning pointer events back on. Its buttons could
 * not be clicked even with the pointer resting on them: clicks went to
 * whatever sat underneath.
 *
 * jsdom does not apply stylesheets, so this resolves the cascade by hand, for
 * the only selectors these cards are styled by: compounds of their own
 * classes (`.a`, `.a.b`). More classes win; on a tie, the later rule wins.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const appCss = strip(readFileSync(resolve(here, "app.css"), "utf8"));

const rules = [...appCss.matchAll(/([^@{};\s][^{};]*)\{([^{}]*)\}/g)].map(
  (m, order) => ({
    order,
    selectors: m[1]!.split(",").map((s) => s.trim()),
    body: m[2]!
  })
);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every `useViewportTooltip("classes", { … interactive: true … })`. */
const interactiveCards = sources(root).flatMap((path) =>
  [
    ...readFileSync(path, "utf8").matchAll(
      /useViewportTooltip\(\s*"([^"]+)"\s*,\s*\{([^}]*)\}/g
    )
  ]
    .filter((m) => /\binteractive:\s*true\b/.test(m[2]!))
    .map((m) => ({ file: relative(root, path), classes: m[1]!.split(/\s+/) }))
);

function pointerEvents(classes: string[]): string | undefined {
  let winner: { specificity: number; order: number; value: string } | undefined;
  for (const rule of rules) {
    const found = /(?:^|;)\s*pointer-events\s*:\s*([^;]+);/.exec(rule.body);
    if (!found) continue;
    for (const selector of rule.selectors) {
      const compound = /^(?:\.[\w-]+)+$/.exec(selector);
      if (!compound) continue;
      const parts = selector.slice(1).split(".");
      if (!parts.every((part) => classes.includes(part))) continue;
      const candidate = { specificity: parts.length, order: rule.order, value: found[1]!.trim() };
      if (
        winner === undefined ||
        candidate.specificity > winner.specificity ||
        (candidate.specificity === winner.specificity && candidate.order >= winner.order)
      ) {
        winner = candidate;
      }
    }
  }
  return winner?.value;
}

describe("interactive hover cards take the pointer", () => {
  it("finds the interactive cards", () => {
    // A guard on the scan itself: if the call shape changes, this test
    // must not pass by finding nothing.
    expect(interactiveCards.map((card) => card.classes.join(" "))).toEqual(
      expect.arrayContaining([
        "viewport-tooltip discovery-explain-popover",
        "commit-context-card"
      ])
    );
  });

  it.each(interactiveCards.map((card) => [`${card.classes.join(" ")} (${card.file})`, card.classes]))(
    "%s resolves to pointer-events: auto",
    (_label, classes) => {
      expect(pointerEvents(classes as string[]) ?? "auto").toBe("auto");
    }
  );
});
