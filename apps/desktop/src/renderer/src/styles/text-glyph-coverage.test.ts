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
 * It cannot see which stack a site sets a character in, so it asks every
 * stack: each character must draw in a bundled face whether the site is set in
 * `--font-sans` or `--font-mono`. Asking whether *either* face had it once
 * passed `●` while every badge that drew it set it in mono, where Geist Mono
 * lacks it and the glyph fell back to Menlo. See "A bundled font is requested
 * by its `@font-face` name" in `styles/AGENTS.md`.
 *
 * Coverage is read from the faces themselves — the `cmap` of every `.woff`
 * fonts.css loads, through its `@fontsource` imports or its own `@font-face`
 * rules, narrowed by each face's `unicode-range` — so a font update that drops
 * a codepoint fails here rather than in a screenshot.
 */

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, "..");
const require = createRequire(import.meta.url);

/** Characters still drawn from text that some font stack cannot draw in a
 *  bundled face. Each needs a named owner; an entry that is no longer used
 *  fails the last test. */
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

/** A `unicode-range` as a predicate; no descriptor means every codepoint. */
function rangeOf(descriptor: string | undefined): (cp: number) => boolean {
  if (descriptor === undefined) return () => true;
  const spans = descriptor.split(",").map((part) => {
    const m = /^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    if (m === null) throw new Error(`unreadable unicode-range part "${part}"`);
    const lo = parseInt(m[1]!.replace(/\?/g, "0"), 16);
    const hi = parseInt((m[2] ?? m[1]!).replace(/\?/g, "F"), 16);
    return [lo, hi] as const;
  });
  return (cp) => spans.some(([lo, hi]) => cp >= lo && cp <= hi);
}

type Face = { family: string; weight: string; file: string; codepoints: Set<number> };

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const unquote = (family: string): string => family.trim().replace(/^(["'])(.*)\1$/, "$2");

/** The faces a stylesheet declares, each with the codepoints it can actually
 *  draw: its `.woff`'s cmap (they name the `.woff2`; @fontsource ships a zlib
 *  `.woff` beside each) narrowed by its `unicode-range`, because a codepoint
 *  outside the range never reaches the face however the file reads. */
function facesIn(cssPath: string, css: string): Face[] {
  return [...strip(css).matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
    const descriptor = (name: string): string | undefined =>
      new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(body!)?.[1]?.trim();
    const url = /url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/.exec(body!)?.[1];
    if (url === undefined) throw new Error(`a face in ${cssPath} names no .woff2`);
    const woff = url.replace(/\.woff2$/, ".woff");
    const file = woff.startsWith(".") ? resolve(dirname(cssPath), woff) : require.resolve(woff);
    const inRange = rangeOf(descriptor("unicode-range"));
    return {
      family: unquote(descriptor("font-family")!),
      weight: descriptor("font-weight")!,
      file,
      codepoints: new Set([...cmapOf(file)].filter(inRange))
    };
  });
}

/** Every face fonts.css loads: those its `@import`s declare, then its own. */
function bundledFaces(): Face[] {
  const fontsPath = resolve(here, "fonts.css");
  const fontsCss = strip(readFileSync(fontsPath, "utf8"));
  const faces: Face[] = [];
  for (const [, spec] of fontsCss.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
    const cssPath = require.resolve(spec!);
    faces.push(...facesIn(cssPath, readFileSync(cssPath, "utf8")));
  }
  faces.push(...facesIn(fontsPath, fontsCss));
  return faces;
}

/** Each font token's stacks, cut to the leading run of bundled families: the
 *  part that decides whether a glyph draws in a bundled face. A bundled family
 *  behind an OS font is never reached for a glyph the OS font has, so it does
 *  not count. */
function bundledStacks(faces: Face[]): { token: string; families: string[] }[] {
  const tokensCss = strip(readFileSync(resolve(here, "tokens.css"), "utf8"));
  const bundled = new Set(faces.map((face) => face.family));
  return ["--font-sans", "--font-mono"].flatMap((token) =>
    [...tokensCss.matchAll(new RegExp(`${token}\\s*:\\s*([^;]+);`, "g"))].map((m) => {
      const stack = m[1]!.split(",").map(unquote);
      const run = stack.findIndex((family) => !bundled.has(family));
      return { token, families: run === -1 ? stack : stack.slice(0, run) };
    })
  );
}

const codepointsOf = (faces: Face[], families: string[]): Set<number> =>
  new Set(faces.filter((face) => families.includes(face.family)).flatMap((face) => [...face.codepoints]));

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

const faces = bundledFaces();
const stacks = bundledStacks(faces);
const drawn = drawnCharacters();
const cp = (ch: string): number => ch.codePointAt(0)!;
const label = (ch: string): string => `${ch} U+${cp(ch).toString(16).toUpperCase()}`;

describe("text the renderer draws", () => {
  it("reads real coverage out of the bundled faces", () => {
    // Without this a path change would leave an empty set and fail every
    // character — or, worse, a reader that returned too much would pass all.
    const sans = codepointsOf(faces, ["Geist Sans"]);
    expect(sans.has(cp("A"))).toBe(true);
    expect(sans.has(cp("…"))).toBe(true);
    // ↻ is in neither face; a reader that finds it is reading the file wrong.
    expect(codepointsOf(faces, [...new Set(faces.map((f) => f.family))]).has(cp("↻"))).toBe(false);
    // The range is applied: the symbols alias shares Geist Sans's files but
    // must not report the letters those files carry.
    const symbols = codepointsOf(faces, ["Geist Sans Symbols"]);
    expect(symbols.has(cp("↵"))).toBe(true);
    expect(symbols.has(cp("A"))).toBe(false);
    // And each stack resolved to at least one bundled family.
    for (const { token, families } of stacks) expect(families, token).not.toHaveLength(0);
  });

  it.each(["--font-sans", "--font-mono"])("draws every character in a bundled face when set in %s", (token) => {
    const missing = stacks
      .filter((stack) => stack.token === token)
      .flatMap(({ families }) => {
        const covered = codepointsOf(faces, families);
        return [...drawn]
          .filter(([ch]) => !covered.has(cp(ch)) && PENDING[ch] === undefined)
          .map(([ch, where]) => `${label(ch)} at ${where.join(", ")}`);
      });
    expect(
      missing,
      `${token}'s bundled families (${stacks.find((s) => s.token === token)?.families.join(", ")}) lack these. ` +
        "An icon belongs in a lib/*Glyph.tsx component; typography another bundled face has belongs " +
        "in a fallthrough face in fonts.css, as Geist Sans Symbols is for the mono stack"
    ).toEqual([]);
  });

  it("gives a fallthrough face nothing the face ahead of it draws", () => {
    // A family behind the lead is reached per glyph, so after load it can only
    // ever draw what the lead lacks. But while the lead is still loading,
    // font-display: swap hands *every* glyph to the next loaded family — and
    // a fallthrough that also had digits and letters would set mono text in a
    // proportional face for that moment. Keeping the ranges disjoint means
    // mono text never takes any metrics but Geist Mono's.
    const overlaps = stacks.flatMap(({ token, families }) =>
      families.slice(1).flatMap((family, i) => {
        const ahead = codepointsOf(faces, families.slice(0, i + 1));
        return [...codepointsOf(faces, [family])]
          .filter((c) => ahead.has(c))
          .map((c) => `${token}: ${family} claims ${label(String.fromCodePoint(c))}`);
      })
    );
    expect(overlaps, "narrow the fallthrough face's unicode-range").toEqual([]);
  });

  it("gives a fallthrough face every weight of the face it backs", () => {
    // A 700 mono rule draws Geist Mono at its heaviest bundled weight, 600;
    // the glyphs that fall through should come out at the same weight.
    const weights = (family: string): string[] =>
      [...new Set(faces.filter((face) => face.family === family).map((face) => face.weight))].sort();
    for (const { families } of stacks) {
      for (const family of families.slice(1)) expect(weights(family), family).toEqual(weights(families[0]!));
    }
  });

  it("keeps no stale entry in the pending list", () => {
    const stale = Object.keys(PENDING).filter((ch) => !drawn.has(ch));
    expect(stale, "no longer drawn from text; delete it from PENDING").toEqual([]);
  });
});
