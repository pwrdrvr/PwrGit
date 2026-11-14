import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A sticky element's inset is measured from its scroll container's PADDING
 * edge, not the scrollport's. So `top: 0` inside a scroller with
 * `padding-top: 14px` sticks 14px down, and rows scroll past in the band
 * above it — content slides under the head, then reappears over it. This has
 * shipped more than once (the diff file head in three hosts).
 *
 * The oracle: every sticky rule in the renderer's stylesheets is listed here
 * with the scroll container it sticks in, and for each inset side it uses,
 * that container either has no padding on that side, or the rule pulls
 * itself back by it. A new sticky rule fails until someone has made that
 * call. `e2e/sticky-heads.spec.ts` measures the diff heads in real layout.
 */

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, "..");

type Rule = { selector: string; body: string };

/** Leaf rules (selector + declarations), through @media and friends. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let depth = 0;
  let start = 0;
  const stack: { prelude: string; open: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      stack.push({ prelude: text.slice(start, i).trim(), open: i + 1 });
      depth++;
      start = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      depth--;
      if (top !== undefined) {
        const body = text.slice(top.open, i);
        if (!body.includes("{") && !top.prelude.startsWith("@")) {
          out.push({ selector: top.prelude.replace(/\s+/g, " "), body });
        }
      }
      start = i + 1;
    } else if (ch === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return out;
}

function sources(dir: string, ext: RegExp, acc: { file: string; text: string }[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) sources(full, ext, acc);
    else if (ext.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push({ file: full, text: readFileSync(full, "utf8") });
    }
  }
  return acc;
}

const ALL = sources(rendererRoot, /\.css$/).flatMap(({ text }) => rules(text));

const decl = (body: string, prop: string): string | undefined => {
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m?.[1]?.trim();
};

/** Every rule whose selector list contains exactly `selector`. */
const rulesFor = (selector: string): Rule[] =>
  ALL.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));

type Side = "top" | "left";

/** Splits a shorthand's value on spaces outside parentheses. */
const words = (v: string): string[] => v.split(/\s+(?![^(]*\))/);

/**
 * The container's padding on one side, from its own rules (last wins), read
 * through the physical and the logical properties (horizontal LTR).
 */
function paddingOf(container: string, side: Side): string {
  let value = "0";
  const axis = side === "top" ? "block" : "inline";
  for (const r of rulesFor(container)) {
    // Declaration order within a rule is not tracked; one rule sets one form.
    const short = decl(r.body, "padding");
    if (short !== undefined) {
      const parts = words(short);
      value = side === "top" ? parts[0]! : (parts[3] ?? parts[1] ?? parts[0])!;
    }
    const logical = decl(r.body, `padding-${axis}`);
    if (logical !== undefined) value = words(logical)[0]!;
    const start = decl(r.body, `padding-${axis}-start`);
    if (start !== undefined) value = start;
    const longhand = decl(r.body, `padding-${side}`);
    if (longhand !== undefined) value = longhand;
  }
  return value;
}

/**
 * The inset a sticky rule ends up with on one side: its own, unless a later
 * rule that targets the same element (`.x .sticky`, `.sticky.is-y`) sets it.
 * Each such override has to account for the padding too.
 */
function insetsOf(selector: string, side: Side): string[] {
  // The element itself, under a context or in a state; never a ::pseudo
  // element, which is a separate box with its own positioning.
  const targets = (part: string): boolean =>
    !part.includes("::") &&
    (part === selector ||
      part.endsWith(` ${selector}`) ||
      part.endsWith(`>${selector}`) ||
      part.startsWith(`${selector}.`) ||
      part.startsWith(`${selector}:`));
  return ALL.filter((r) => r.selector.split(",").map((p) => p.trim()).some(targets))
    .map((r) => decl(r.body, side))
    .filter((v): v is string => v !== undefined);
}

const isZero = (v: string): boolean => /^0(px)?$/.test(v);

/**
 * Where each sticky rule sticks. `compensated` names how a rule copes with a
 * padded container when it does not simply pull itself back.
 */
const INVENTORY: Record<string, { containers: string[]; compensated?: string }> = {
  ".repo-row": { containers: [".sidebar__list"] },
  ".wt-row.is-selected": { containers: [".sidebar__list"] },
  ".repo-group__head": { containers: [".sidebar__list"] },
  ".log-window__line-number": { containers: [".log-window__viewport"] },
  ".diff-file__head": {
    containers: [".diff-pane__body", ".cr-view__body", ".file-insight-pane__body"]
  },
  ".maintenance__body > .bulk-sync__status.is-live": {
    containers: [".maintenance__body"],
    // Sticks 12px down on purpose and paints the band with its box-shadow,
    // in the dialog's own fill, so no row shows through above the card.
    compensated: "box-shadow paints the padding band"
  }
};

const STICKY = ALL.filter((r) => decl(r.body, "position") === "sticky");

describe("sticky elements vs their scroll container's padding", () => {
  it("finds the sticky rules (the parser is not silently empty)", () => {
    expect(STICKY.length).toBeGreaterThanOrEqual(Object.keys(INVENTORY).length);
  });

  it("sets sticky only in stylesheets, where this test can see it", () => {
    const inline = sources(rendererRoot, /\.tsx?$/)
      .filter(({ text }) => /position\s*:\s*["'`]sticky/.test(text))
      .map(({ file }) => file);
    expect(inline, "Move inline sticky positioning into app.css and INVENTORY").toEqual([]);
  });

  it("lists every sticky rule with the container it sticks in", () => {
    const unlisted = STICKY.map((r) => r.selector).filter((s) => !(s in INVENTORY));
    expect(
      unlisted,
      "New sticky rule: add it to INVENTORY with its scroll container, and make sure " +
        "its inset accounts for that container's padding (see .diff-file__head)."
    ).toEqual([]);
  });

  for (const [selector, { containers, compensated }] of Object.entries(INVENTORY)) {
    it(`${selector} sits flush with the scrollport edge it sticks to`, () => {
      const rule = STICKY.find((r) => r.selector === selector);
      expect(rule, `${selector} is no longer sticky; drop it from INVENTORY`).toBeDefined();
      for (const side of ["top", "left"] as const) {
        const insets = insetsOf(selector, side);
        if (insets.length === 0) continue;
        for (const container of containers) {
          expect(rulesFor(container).length, `no rule for ${container}`).toBeGreaterThan(0);
          const pad = paddingOf(container, side);
          if (isZero(pad) || compensated !== undefined) continue;
          // Padded: the container must publish its padding through the
          // shared property, and every inset the sticky can end up with must
          // pull it back by that much.
          expect(pad, `${container} pads its ${side} with a literal`).toBe(
            "var(--sticky-scroll-pad-top)"
          );
          for (const inset of insets) {
            expect(inset, `${selector} sticks ${pad} inside ${container}`).toMatch(
              /calc\(\s*-1\s*\*\s*var\(--sticky-scroll-pad-top/
            );
          }
        }
      }
    });
  }
});
