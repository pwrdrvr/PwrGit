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

  it("contains layout and paint inside .bulk-sync and strict-contains .bulk-sync__bar", () => {
    const dialogBody = /\.bulk-sync\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const barBody = /\.bulk-sync__bar\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(dialogBody).toMatch(/\bcontain\s*:\s*layout\s+paint\b/);
    expect(barBody).toMatch(/\bcontain\s*:\s*strict\b/);
  });

  it("animates bulk-sync-stripes via compositor transform on ::before without flex-grow layout transitions", () => {
    const keyframes = /@keyframes\s+bulk-sync-stripes\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(keyframes).toBeDefined();
    expect(keyframes).not.toMatch(/\bbackground-position\s*:/);
    expect(keyframes).toMatch(/\btransform\s*:/);
    const segmentBody = /\.bulk-sync__bar\s*>\s*i\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(segmentBody).not.toMatch(/\btransition\s*:\s*[^;]*flex-grow\b/);
    expect(css).toMatch(/\.is-in-flight[^{]*::before\s*\{[^}]*animation\s*:\s*bulk-sync-stripes\b/);
  });

  it("size-contains .sidebar__list without paint or layout containment to isolate sticky rows from toolbar updates", () => {
    const listBody = /(?:^|\n)\.sidebar__list\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(listBody).toMatch(/\bcontain\s*:\s*size\s*;/);
    expect(listBody).not.toMatch(/\bcontain\s*:\s*[^;]*(?:paint|layout)\b/);
  });

  it("contains bulk-sync repository cards for offscreen skipping", () => {
    const reposBody = /\.bulk-sync__repos\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const cardBody = /\.bulk-sync__repo\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(reposBody).toMatch(/\bcontain\s*:\s*layout\s+paint\s+style\b/);
    expect(cardBody).toMatch(/\bcontent-visibility\s*:\s*auto\b/);
  });
});
