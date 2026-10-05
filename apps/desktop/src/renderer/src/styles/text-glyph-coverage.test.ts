import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every character the renderer draws from source text must exist in a bundled
 * face. One that doesn't resolves through an OS fallback font and changes
 * shape, size and baseline per platform; nothing warns. That is how `✓`, `✕`,
 * `⚙`, `＋`, `ⓘ`, `⚠`, `⌕` and `⟳` came to draw in Menlo, Zapf Dingbats,
 * PingFang SC and Hiragino Sans beside the SVG icons
 * (`design/Text Glyph Icons - UX Review.dc.html`). An icon is a
 * `lib/*Glyph.tsx` component, never a character.
 *
 * This is a floor, not the whole rule. It asks whether *either* face has the
 * character, because it cannot see which face a site sets it in: `●` is in
 * Geist Sans but not Geist Mono, and every badge that drew it set it in mono,
 * so it fell back while passing a check like this one. See "A bundled font is
 * requested by its `@font-face` name" in `styles/AGENTS.md`.
 *
 * Coverage is read from the faces themselves — the `cmap` of every `.woff`
 * the `@fontsource` stylesheets imported by fonts.css load — so a font update
 * that drops a codepoint fails here rather than in a screenshot.
 */

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, "..");
const require = createRequire(import.meta.url);

/** Characters still drawn from text that no bundled face has. Each needs a
 *  named owner; an entry that is no longer used fails the second test. */
const PENDING: Record<string, string> = {
  // Keycap symbols, not icons: `lib/platform.ts` spells macOS shortcuts with
  // them. They fall back like the mono arrows do, and belong to the same
  // font-stack follow-up to the text-glyph pass, not to a lib glyph.
  "⌥": "keycaps — font-stack follow-up",
  "⌘": "keycaps — font-stack follow-up"
};

/** The codepoints a WOFF 1.0 face maps to a real glyph. WOFF tables are
 *  zlib-compressed when their compressed length is shorter. */
function cmapOf(path: string): Set<number> {
  const woff = readFileSync(path);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < woff.readUInt16BE(12); i++) {
    const at = 44 + 20 * i;
    const tag = woff.toString("latin1", at, at + 4);
    const offset = woff.readUInt32BE(at + 4);
    const compLength = woff.readUInt32BE(at + 8);
    const origLength = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + compLength);
    tables.set(tag, compLength < origLength ? inflateSync(raw) : raw);
  }
  const cmap = tables.get("cmap");
  if (cmap === undefined) throw new Error(`${path} has no cmap`);
  const out = new Set<number>();
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const sub = cmap.readUInt32BE(4 + 8 * i + 4);
    const format = cmap.readUInt16BE(sub);
    if (format === 4) {
      const segs = cmap.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + 2 * segs + 2;
      const deltas = starts + 2 * segs;
      const rangeOffsets = deltas + 2 * segs;
      for (let s = 0; s < segs; s++) {
        const start = cmap.readUInt16BE(starts + 2 * s);
        const end = cmap.readUInt16BE(ends + 2 * s);
        const delta = cmap.readInt16BE(deltas + 2 * s);
        const rangeOffset = cmap.readUInt16BE(rangeOffsets + 2 * s);
        for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
          // A segment can span codepoints that map to glyph 0 (.notdef);
          // those are not in the face, however the range reads.
          let glyph = (cp + delta) & 0xffff;
          if (rangeOffset !== 0) {
            const g = cmap.readUInt16BE(rangeOffsets + 2 * s + rangeOffset + 2 * (cp - start));
            glyph = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (glyph !== 0) out.add(cp);
        }
      }
    } else if (format === 12) {
      for (let g = 0; g < cmap.readUInt32BE(sub + 12); g++) {
        const at = sub + 16 + 12 * g;
        for (let cp = cmap.readUInt32BE(at); cp <= cmap.readUInt32BE(at + 4); cp++) out.add(cp);
      }
    }
  }
  return out;
}

/** Every `.woff` the stylesheets fonts.css imports point at (they name the
 *  `.woff2`; @fontsource ships a zlib `.woff` beside each). */
function bundledCoverage(): { faces: string[]; codepoints: Set<number> } {
  const fontsCss = readFileSync(resolve(here, "fonts.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const faces = new Set<string>();
  for (const [, spec] of fontsCss.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
    const cssPath = require.resolve(spec!);
    const css = readFileSync(cssPath, "utf8");
    for (const [, file] of css.matchAll(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/g)) {
      faces.add(resolve(dirname(cssPath), file!.replace(/\.woff2$/, ".woff")));
    }
  }
  const codepoints = new Set<number>();
  for (const face of faces) for (const cp of cmapOf(face)) codepoints.add(cp);
  return { faces: [...faces], codepoints };
}

/** Non-ASCII characters in the text a component draws: JSX text, string
 *  literals and template text. The AST keeps comments out, which is where
 *  most of the renderer's arrows and check marks live. Plain `.ts` is walked
 *  too: helpers such as `lib/platform.ts` and the menu builders hand strings
 *  to components that draw them. */
function drawnCharacters(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !entry.name.includes(".test.")) scan(path);
    }
  };
  const scan = (path: string): void => {
    // By extension: a `.ts` file read as TSX misparses `<T>expr` casts.
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
        for (const ch of node.text) {
          if (ch.codePointAt(0)! <= 0x7f) continue;
          const where = `${relative(rendererRoot, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          found.set(ch, [...(found.get(ch) ?? []), where]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  walk(rendererRoot);
  return found;
}

const coverage = bundledCoverage();
const drawn = drawnCharacters();

describe("text the renderer draws", () => {
  it("reads real coverage out of the bundled faces", () => {
    // Without this a path change would leave an empty set and fail every
    // character — or, worse, a reader that returned too much would pass all.
    expect(coverage.faces.length).toBeGreaterThan(1);
    expect(coverage.codepoints.has("A".codePointAt(0)!)).toBe(true);
    expect(coverage.codepoints.has("…".codePointAt(0)!)).toBe(true);
    // ↻ is in neither face; a reader that finds it is reading the file wrong.
    expect(coverage.codepoints.has("↻".codePointAt(0)!)).toBe(false);
  });

  it("uses no character that neither bundled face can draw", () => {
    const missing = [...drawn]
      .filter(([ch]) => !coverage.codepoints.has(ch.codePointAt(0)!) && PENDING[ch] === undefined)
      .map(([ch, where]) => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase()} at ${where.join(", ")}`);
    expect(missing, "draw these with a lib/*Glyph.tsx component instead").toEqual([]);
  });

  it("keeps no stale entry in the pending list", () => {
    const stale = Object.keys(PENDING).filter((ch) => !drawn.has(ch));
    expect(stale, "no longer drawn from text; delete it from PENDING").toEqual([]);
  });
});
