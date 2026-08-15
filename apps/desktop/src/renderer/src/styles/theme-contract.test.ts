import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TITLE_BAR_OVERLAY_BACKGROUND,
  TITLE_BAR_OVERLAY_SYMBOL,
  WINDOW_BACKGROUND
} from "../../../main/window-chrome";

/**
 * The theme's structural invariants, as tests. `lint:colors` guarantees no raw
 * literals escape the token blocks; this guarantees the blocks themselves stay
 * coherent — that both themes cover the same surface, and that nothing is
 * declared and then forgotten.
 *
 * Modelled on PwrAgnt's `theme-contract.test.tsx`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(resolve(here, "tokens.css"), "utf8");
const appCss = readFileSync(resolve(here, "app.css"), "utf8");

/** Every renderer source that can reference a token — CSS rules and the TSX
 *  that passes `var(--lane-N)` into SVG presentation attributes. */
function rendererSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) rendererSources(full, acc);
    else if (/\.(css|tsx?)$/.test(entry) && entry !== "tokens.css") {
      acc.push(readFileSync(full, "utf8"));
    }
  }
  return acc;
}

/** Strip comments so a token named in prose isn't mistaken for a declaration. */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const source = strip(tokensCss);
  const start = source.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing token block: ${selector}`);
  return source.slice(start, source.indexOf("\n}", start));
}

const declaredIn = (selector: string): Set<string> =>
  new Set(
    [...block(selector).matchAll(/^\s+(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!)
  );

const dark = declaredIn(":root");
const light = declaredIn(':root[data-theme="light"]');

/**
 * Tokens the light block deliberately inherits from the dark block. Each is
 * either theme-neutral by design or derived via color-mix from a base that
 * does flip — overriding the base is enough. Adding to this list is a design
 * decision; the test exists so it's a deliberate one.
 */
const INHERITS_FROM_DARK = new Set([
  // Derived via color-mix from a base the light block overrides.
  "--accent-soft",
  "--accent-tint",
  "--accent-border",
  "--warn-soft",
  "--bg-overlay",
  "--scrollbar-thumb",
  "--pr-dot-ring",
  // Theme-neutral by design.
  "--shadow-base", // drop shadows stay dark in both themes
  "--status-closed", // product choice: closed-without-merge is black in both
  "--lane-1", // follows --accent
  "--focus-ring", // follows --accent
  // Alias tokens: resolve through a base the light block overrides.
  "--bg-menu",
  // Not colors.
  "--font-sans",
  "--font-mono",
  "--sidebar-title-size", // appearance axis, theme-neutral (see tokens.css)
  "--sidebar-repo-row-height", // derived from the axis; not a color
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl"
]);

describe("theme contract", () => {
  it("gives every dark token a light counterpart, or an explicit exemption", () => {
    const missing = [...dark].filter(
      (t) => !light.has(t) && !INHERITS_FROM_DARK.has(t)
    );
    expect(missing).toEqual([]);
  });

  it("declares no light token that the dark block doesn't", () => {
    // The dark block is the canonical surface; light only overrides.
    expect([...light].filter((t) => !dark.has(t))).toEqual([]);
  });

  it("keeps the exemption list honest — no stale entries", () => {
    const stale = [...INHERITS_FROM_DARK].filter(
      (t) => !dark.has(t) || light.has(t)
    );
    expect(stale).toEqual([]);
  });

  it("references every declared token somewhere", () => {
    // A token nobody reads is a value that drifts silently. If a token is here
    // for a future surface, use it or drop it.
    const consumers =
      rendererSources(resolve(here, "..")).join("\n") + strip(tokensCss);
    const orphans = [...dark].filter(
      (t) => !consumers.includes(`var(${t})`)
    );
    expect(orphans).toEqual([]);
  });

  it("mirrors the main process's pre-paint chrome onto the dark tokens", () => {
    // These paint before the renderer exists, so they're hand-copied literals
    // in src/main/window-chrome.ts. Pin them to the tokens they mirror.
    const valueOf = (token: string): string => {
      const m = block(":root").match(
        new RegExp(`^\\s+${token}\\s*:\\s*([^;]+);`, "m")
      );
      if (m === null) throw new Error(`missing token: ${token}`);
      return m[1]!.trim();
    };
    expect(WINDOW_BACKGROUND).toBe(valueOf("--bg-app"));
    expect(TITLE_BAR_OVERLAY_BACKGROUND).toBe(valueOf("--bg-titlebar"));
    expect(TITLE_BAR_OVERLAY_SYMBOL).toBe(valueOf("--text-secondary"));
  });
});

describe("accent ramp usage", () => {
  /**
   * --accent-bright is contrast-floored against an --accent-soft tint (4.64:1
   * there vs 5.45:1 on a flat surface); --accent is tuned for flat surfaces.
   * Swapping them doesn't read as emphasis, it reads as a second, duller
   * orange — which is what made the app look like it had two accents.
   *
   * So the pairing is checked in BOTH directions. One direction alone is
   * useless: the retune's actual bug was accent-bright → accent on a tinted
   * surface, and a test that only looks at accent-bright rules skips those
   * rules entirely once they stop mentioning it.
   *
   * The tint may come from the rule's own body OR from an ancestor in its
   * selector. The ancestor case is what a per-rule scan misses, and it is how
   * `.wt-row.is-selected .wt-row__branch` and `.clone-protocol.is-active
   * strong` were misclassified.
   */
  // Translucent/dark accent washes. A SOLID var(--accent) fill is excluded on
  // purpose: text on that is --accent-on, not either ramp rung.
  const TINT = /accent-soft|accent-tint|bg-row-active|bg-active-strong/;

  const rules = [...strip(appCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({ selector: selector!.trim(), body: body! })
  );

  const backgroundOf = (body: string): string =>
    (body.match(/background[^;]*/g) ?? []).join(" ");

  /** Does any ancestor compound in this selector paint an accent tint? */
  function ancestorTinted(selector: string): boolean {
    return selector.split(",").some((part) => {
      const ancestors = part.trim().split(/\s+/).slice(0, -1);
      return ancestors.some((ancestor) =>
        rules.some(
          (r) =>
            r.selector.split(",").some((s) => s.trim() === ancestor) &&
            TINT.test(backgroundOf(r.body))
        )
      );
    });
  }

  const onTint = (r: { selector: string; body: string }): boolean =>
    TINT.test(backgroundOf(r.body)) || ancestorTinted(r.selector);

  const paints = (body: string, token: string): boolean =>
    new RegExp(`^\\s*color\\s*:\\s*var\\(${token}\\)`, "m").test(body);

  const label = (r: { selector: string }): string =>
    r.selector.replace(/\s+/g, " ").slice(0, 80);

  it("never paints --accent-bright on a flat surface", () => {
    const offenders = rules
      .filter((r) => paints(r.body, "--accent-bright") && !onTint(r))
      .map(label);
    expect(offenders).toEqual([]);
  });

  it("never paints --accent on an accent tint", () => {
    const offenders = rules
      .filter((r) => paints(r.body, "--accent") && onTint(r))
      .map(label);
    expect(offenders).toEqual([]);
  });
});
