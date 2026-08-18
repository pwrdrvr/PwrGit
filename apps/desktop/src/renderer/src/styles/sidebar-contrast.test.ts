import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.1 AA contrast, measured from the token blocks themselves.
 *
 * `lint:colors` guarantees no literal escapes tokens.css and
 * `theme-contract.test.ts` guarantees both themes declare the same surfaces —
 * neither says anything about whether the resulting text can be READ. This
 * does: it resolves each token (including alpha compositing and `color-mix`),
 * composites the ink over the surface it is actually painted on, and asserts
 * the ratio.
 *
 * Deliberately pinned to RATIOS, not to token values: the whole point is that
 * a future palette change is free to move a colour as long as it stays legible,
 * and is caught the moment it doesn't. Every pairing below corresponds to a
 * real sidebar rule in app.css; the comment on each names it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(resolve(here, "tokens.css"), "utf8");

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const source = strip(tokensCss);
  const start = source.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing token block: ${selector}`);
  return source.slice(start, source.indexOf("\n}", start));
}

/** Raw declarations of one theme block, `--name` -> value string. */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block(selector).matchAll(/^\s+(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const DARK = declarations(":root");
const LIGHT = new Map([...DARK, ...declarations(':root[data-theme="light"]')]);

type Rgba = { r: number; g: number; b: number; a: number };

const clamp255 = (n: number): number => Math.min(255, Math.max(0, n));

/** Resolve one token to premultiplied-free RGBA, following var()/color-mix. */
function resolve_(theme: Map<string, string>, value: string, depth = 0): Rgba {
  if (depth > 12) throw new Error(`token cycle at ${value}`);
  const v = value.trim();

  const varMatch = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (varMatch !== null) {
    const next = theme.get(varMatch[1]!);
    if (next === undefined) throw new Error(`undefined token ${varMatch[1]}`);
    return resolve_(theme, next, depth + 1);
  }

  // color-mix(in srgb, <colour> N%, transparent) — the only form the palette
  // uses, and it is exactly "take this colour at N% alpha".
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix !== null) {
    const base = resolve_(theme, mix[1]!, depth + 1);
    return { ...base, a: base.a * (Number(mix[2]) / 100) };
  }

  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex !== null) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/.exec(v);
  if (rgba !== null) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4])
    };
  }

  throw new Error(`cannot resolve colour: ${v}`);
}

const token = (theme: Map<string, string>, name: string): Rgba => {
  const raw = theme.get(name);
  if (raw === undefined) throw new Error(`undefined token ${name}`);
  return resolve_(theme, raw);
};

/** Paint `top` over `bottom`. */
const over = (top: Rgba, bottom: Rgba): Rgba => ({
  r: top.a * top.r + (1 - top.a) * bottom.r,
  g: top.a * top.g + (1 - top.a) * bottom.g,
  b: top.a * top.b + (1 - top.a) * bottom.b,
  a: 1
});

/** Composite a stack of tokens, bottom first, into one opaque colour. */
function surface(theme: Map<string, string>, stack: string[]): Rgba {
  let base = token(theme, stack[0]!);
  for (const name of stack.slice(1)) base = over(token(theme, name), base);
  return base;
}

/** Element-level `opacity` blends the whole element with what is behind it. */
const faded = (colour: Rgba, opacity: number, behind: Rgba): Rgba =>
  over({ ...colour, a: opacity }, behind);

const channel = (c: number): number => {
  const s = clamp255(c) / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = (c: Rgba): number =>
  0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Ink `fg` painted on the surface `bg` resolves to, as a ratio. */
function ratio(
  theme: Map<string, string>,
  fg: string,
  bg: string[],
  opacity = 1
): number {
  const surf = surface(theme, bg);
  const ink = over(token(theme, fg), surf);
  return contrast(opacity === 1 ? ink : faded(ink, opacity, surf), surf);
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Every surface a sidebar row can sit on, so a quiet ink is checked on all. */
const ROW_SURFACES: string[][] = [
  ["--bg-sidebar"],
  ["--bg-panel"],
  ["--bg-panel-hover"], // :hover
  ["--bg-hover-strong"], // .repo-row.is-active
  ["--bg-row-active"] // .wt-row.is-selected
];

const THEMES: [string, Map<string, string>][] = [
  ["dark", DARK],
  ["light", LIGHT]
];

describe.each(THEMES)("sidebar contrast — %s theme", (themeName, theme) => {
  // ---- SC 1.4.3, 4.5:1. Every text run in the sidebar is under 18.66px
  // bold / 24px regular, so none of them qualifies for the large-text 3:1.
  describe("1.4.3 text (4.5:1)", () => {
    it.each(ROW_SURFACES)(
      "--text-subtle carries counts, ages and eyebrows on %s",
      (...bg) => {
        // .repo-row__wtcount, .wt-age, .wt-row__folder, .wt-section__label,
        // .ref-section__label, .ref-section__count, .repo-row__pin-via,
        // .repo-group__count, .lens-filter__count, .sidebar__empty and
        // .overlay-result__folder all paint with this one token.
        expect(round(ratio(theme, "--text-subtle", bg))).toBeGreaterThanOrEqual(
          4.5
        );
      }
    );

    // Narrower than ROW_SURFACES on purpose. --text-muted paints .sort-cycle,
    // .ref-section__head, .new-wt, .add-folder, .repo-group__label and the
    // stale branch line — none of which lands on --bg-hover-strong (that is
    // .repo-row.is-active, whose only text is the name and the count) or on
    // --bg-row-active (a selected row repaints its branch --accent-bright).
    it.each([["--bg-sidebar"], ["--bg-panel"], ["--bg-panel-hover"]])(
      "--text-muted on %s",
      (...bg) => {
        expect(round(ratio(theme, "--text-muted", bg))).toBeGreaterThanOrEqual(
          4.5
        );
      }
    );

    it.each(ROW_SURFACES)("--text-secondary on %s", (...bg) => {
      // .wt-row__branch
      expect(round(ratio(theme, "--text-secondary", bg))).toBeGreaterThanOrEqual(
        4.5
      );
    });

    it("--text-primary names the repo row", () => {
      expect(
        round(ratio(theme, "--text-primary", ["--bg-sidebar"]))
      ).toBeGreaterThanOrEqual(4.5);
    });

    it("--status-warning reads as a badge and as bare text", () => {
      // .badge--warn sits on --warn-soft, which is derived from this same
      // token — so the wash always tracks the ink and is the tighter of the
      // two. .badge-text--warn and .ref-section__summary are the bare case.
      expect(
        round(ratio(theme, "--status-warning", ["--bg-sidebar", "--warn-soft"]))
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        round(ratio(theme, "--status-warning", ["--bg-sidebar"]))
      ).toBeGreaterThanOrEqual(4.5);
    });

    it("--success-text reads as ↑ahead and as the 'in default' tag", () => {
      expect(
        round(ratio(theme, "--success-text", ["--bg-sidebar"]))
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        round(ratio(theme, "--success-text", ["--bg-sidebar", "--success-soft"]))
      ).toBeGreaterThanOrEqual(4.5);
    });

    it("--danger-text reads as the 'diverged' tag", () => {
      expect(
        round(ratio(theme, "--danger-text", ["--bg-sidebar", "--danger-soft"]))
      ).toBeGreaterThanOrEqual(4.5);
    });

    it("--accent-bright reads on the tints it is floored against", () => {
      // .wt-row.is-selected .wt-row__branch, .wt-tag--local, .wt-selbar__count.
      // tokens.css: paint text with --accent-bright only ON an --accent-soft
      // tint or --bg-row-active, never on a flat surface.
      expect(
        round(ratio(theme, "--accent-bright", ["--bg-row-active"]))
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        round(ratio(theme, "--accent-bright", ["--bg-sidebar", "--accent-soft"]))
      ).toBeGreaterThanOrEqual(4.5);
    });

    it("--accent names the repo holding the selection", () => {
      // .repo-row__name.is-active, .ref-view-all
      expect(
        round(ratio(theme, "--accent", ["--bg-sidebar"]))
      ).toBeGreaterThanOrEqual(4.5);
    });

    it("a row being dragged stays readable", () => {
      // .repo-row.is-dragging / .wt-row.is-dragging used to fade the whole row,
      // text included — at opacity 0.4 the branch line measured 2.29:1 and the
      // count 1.48:1. The row is now marked on its own surface instead, so
      // every tier is checked at full strength against that surface.
      for (const ink of ["--text-primary", "--text-secondary", "--text-subtle"]) {
        expect(
          round(ratio(theme, ink, ["--bg-hover-strong"]))
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("the dragged row is marked without dimming its text", () => {
      // The marker is the row's own border turned accent — see app.css. If
      // anyone reintroduces an opacity fade here, the tier assertions above
      // stop describing what is rendered, so pin the mechanism too.
      expect(
        round(ratio(theme, "--accent", ["--bg-hover-strong"]))
      ).toBeGreaterThanOrEqual(3);
    });
  });

  // ---- SC 1.4.11, 3:1 for graphics and for the visual information that
  // identifies a component or its STATE.
  describe("1.4.11 non-text (3:1)", () => {
    it("the focus ring is visible against every surface a row sits on", () => {
      // .repo-row / .wt-row / .lens-chip / .kebab__btn :focus-visible. This is
      // the one that was worst: --accent-border measured 2.27:1 dark,
      // 1.84:1 light, with the UA outline suppressed.
      for (const bg of ROW_SURFACES) {
        expect(round(ratio(theme, "--focus-ring", bg))).toBeGreaterThanOrEqual(3);
      }
    });

    it("the selected worktree row is identifiable as selected", () => {
      // The --bg-row-active fill alone is ~1.03:1 against the sidebar, so the
      // border is what has to carry the state.
      expect(
        round(ratio(theme, "--accent", ["--bg-row-active"]))
      ).toBeGreaterThanOrEqual(3);
    });

    it("the active lens chip is identifiable as active", () => {
      // .lens-chip.is-active sits on the filter's --bg-panel.
      expect(
        round(ratio(theme, "--accent", ["--bg-panel"]))
      ).toBeGreaterThanOrEqual(3);
    });

    it("the drop insertion line reads against the list", () => {
      expect(
        round(ratio(theme, "--accent", ["--bg-sidebar"]))
      ).toBeGreaterThanOrEqual(3);
    });

    it("drag grips and glyph-only controls read", () => {
      // .repo-row__handle, .wt-row__handle, .pin, .ref-mini-action.
      for (const bg of ROW_SURFACES) {
        expect(round(ratio(theme, "--text-subtle", bg))).toBeGreaterThanOrEqual(3);
      }
    });

    it("the disclosure caret reads at its painted opacity", () => {
      // .chev / .ref-section__chev are --text-muted at opacity .82.
      expect(
        round(ratio(theme, "--text-muted", ["--bg-sidebar"], 0.82))
      ).toBeGreaterThanOrEqual(3);
    });

    it("the lens presence dot reads", () => {
      expect(
        round(ratio(theme, "--accent", ["--bg-panel"]))
      ).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("the drag-source treatment the contrast tests assume", () => {
  it("marks the row rather than fading it", () => {
    const appCss = readFileSync(resolve(here, "app.css"), "utf8");
    const rule =
      /\.repo-row\.is-dragging,\s*\.wt-row\.is-dragging\s*\{([^}]*)\}/.exec(appCss);
    expect(rule, "the .is-dragging rule moved or was renamed").not.toBeNull();
    const body = rule?.[1] ?? "";
    // An `opacity` here would take the row's text down with it, which is the
    // failure this whole block exists to keep fixed.
    expect(body).not.toMatch(/opacity\s*:/);
    expect(body).toMatch(/background:\s*var\(--bg-hover-strong\)/);
    expect(body).toMatch(/border-color:\s*var\(--accent\)/);
  });
});
