import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A bundled face is drawn only when some rule asks for it by the exact family
 * name its `@font-face` registers. Nothing warns when the two disagree: the
 * face is never requested, never loads, and text falls through to the next
 * family on the stack — the platform UI font, on a machine without that font
 * installed. PwrGit shipped that way from its first UI commit through 0.17.0:
 * `@fontsource/geist-sans` registers "Geist Sans", `--font-sans` asked for
 * "Geist", and sans text drew in whatever the machine had installed — the
 * system UI font, on a Mac without Geist — while Geist Mono, whose names did
 * agree, rendered correctly beside it.
 *
 * So the family names are read out of the `@fontsource` CSS that fonts.css
 * imports, never restated here — a package that renames its family fails this
 * test instead of a screenshot.
 */

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Strip comments so a family named in prose isn't mistaken for a rule. */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const unquote = (family: string): string =>
  family.trim().replace(/^(["'])(.*)\1$/, "$2");

const fontsCss = strip(readFileSync(resolve(here, "fonts.css"), "utf8"));
const tokensCss = strip(readFileSync(resolve(here, "tokens.css"), "utf8"));

const imports = [...fontsCss.matchAll(/@import\s+["']([^"']+)["']/g)].map(
  (m) => m[1]!
);

/** The families each imported stylesheet registers, resolved the way Vite
 *  resolves the `@import` — through the package's own `exports`. */
const registered = imports.map((spec) => {
  const css = strip(readFileSync(require.resolve(spec), "utf8"));
  const families = [
    ...css.matchAll(/@font-face\s*\{[^}]*?font-family:\s*([^;]+);/g)
  ].map((m) => unquote(m[1]!));
  return { spec, families: [...new Set(families)] };
});

/** A `:root` font stack, first family first. */
function stack(token: string): string[] {
  const start = tokensCss.indexOf(":root {");
  const root = tokensCss.slice(start, tokensCss.indexOf("\n}", start));
  const match = root.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
  if (match === null) throw new Error(`${token} is not declared in :root`);
  return match[1]!.split(",").map(unquote);
}

const FONT_TOKENS = ["--font-sans", "--font-mono"] as const;

describe("bundled fonts", () => {
  it("reads at least one @font-face out of every stylesheet fonts.css imports", () => {
    // Without this, a package that moved its faces elsewhere would leave
    // nothing to check and the test below would pass vacuously.
    expect(imports.length).toBeGreaterThan(0);
    for (const { spec, families } of registered) {
      expect(families, spec).not.toHaveLength(0);
    }
  });

  it.each(
    [...new Set(registered.flatMap(({ families }) => families))].map(
      (family) => [family]
    )
  )("a font token leads with the bundled family %s", (family) => {
    // Leads, not merely names: a family ahead of the bundled one that happens
    // to be installed would mask the bundle on that machine only — the same
    // machine-dependent rendering this exists to prevent.
    const leads = FONT_TOKENS.filter((token) => stack(token)[0] === family);
    expect(
      leads,
      `no font token leads with "${family}"; stacks are ${JSON.stringify(
        Object.fromEntries(FONT_TOKENS.map((token) => [token, stack(token)]))
      )}`
    ).toHaveLength(1);
  });
});
