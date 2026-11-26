import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(join(here, "app.css"), "utf8"));

describe("compositor animations and dialog containment", () => {
  it("runs nav-flash via opacity on a ::before overlay rather than animating box-shadow", () => {
    const keyframes = /@keyframes\s+nav-flash\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(keyframes).toBeDefined();
    expect(keyframes).not.toMatch(/\bbox-shadow\s*:/);
    expect(keyframes).toMatch(/\bopacity\s*:/);
    expect(css).toMatch(/\.is-nav-flash::before\s*\{[^}]*animation\s*:\s*nav-flash\b/);
    expect(css).not.toMatch(/\.is-nav-flash\s*\{[^}]*animation\s*:\s*nav-flash\b/);
  });

  it("contains layout and paint inside .bulk-sync and .bulk-sync__bar", () => {
    const dialogBody = /\.bulk-sync\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const barBody = /\.bulk-sync__bar\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(dialogBody).toMatch(/\bcontain\s*:\s*layout\s+paint\b/);
    expect(barBody).toMatch(/\bcontain\s*:\s*layout\s+paint\b/);
  });
});
