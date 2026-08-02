#!/usr/bin/env node
// Generates the macOS menubar template PNGs (and the colored Windows/Linux
// tray PNGs) from the PwrGit brand mark. Output:
//   apps/desktop/build/tray-icon-template{,@2x,@3x}.png  (alpha-only)
//   apps/desktop/build/tray-icon{,@2x,@3x}.png           (tangerine)
//
// Template PNGs on macOS are alpha-only; the system inverts them to match
// dark / light / accent menubars. Windows and Linux draw the icon as-is in
// the notification area, so those carry the tangerine brand accent.
//
// Run via:
//   pnpm --filter @pwrgit/desktop tray-icon

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const buildDir = resolve(repoRoot, "build");
mkdirSync(buildDir, { recursive: true });

// Lineage mark from the design system (assets/logo-pwrgit.svg), scaled up to
// fill the menubar tile. The design-system SVG uses ~58% of the 128px
// viewBox, which reads tiny next to other menubar icons; this variant spans
// ~88% with a proportionally thicker stroke. The dimmed branch keeps the
// same 0.55 alpha at every size — in the template PNG that becomes partial
// alpha, which macOS tints along with the rest. The dim tier uses a GROUP
// opacity (not per-stroke stroke-opacity) so the arc and the branch ring
// composite once; per-stroke alpha would double up where they overlap.
const ACCENT = "#ff8a1f";
function svgFor(stroke) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <g fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
    <g opacity="0.55">
      <path d="M36 84 C36 56 56 44 77 44" />
      <circle cx="92" cy="44" r="15" />
    </g>
    <path d="M36 39 V89" />
    <circle cx="36" cy="24" r="15" />
    <circle cx="36" cy="104" r="15" />
  </g>
</svg>
`.trim();
}

async function emit(svgStr, baseName, targetPx, suffix) {
  const out = resolve(buildDir, `${baseName}${suffix}.png`);
  await sharp(Buffer.from(svgStr), { density: 72 * (targetPx / 16) })
    .resize(targetPx, targetPx, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`wrote ${out}`);
}

const TEMPLATE_SVG = svgFor("black");
const COLORED_SVG = svgFor(ACCENT);

await Promise.all([
  emit(TEMPLATE_SVG, "tray-icon-template", 16, ""),
  emit(TEMPLATE_SVG, "tray-icon-template", 32, "@2x"),
  emit(TEMPLATE_SVG, "tray-icon-template", 48, "@3x"),
  emit(COLORED_SVG, "tray-icon", 16, ""),
  emit(COLORED_SVG, "tray-icon", 32, "@2x"),
  emit(COLORED_SVG, "tray-icon", 48, "@3x")
]);
