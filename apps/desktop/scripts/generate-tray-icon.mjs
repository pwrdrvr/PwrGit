#!/usr/bin/env node
// Generates PwrGit's tray assets from the same provisional commit-graph mark
// used by generate-app-icon.swift. Keep the output names: Electron's
// nativeImage selects @2x/@3x siblings automatically, and macOS treats the
// `-template` family as an alpha-only image it can tint for any menubar.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const buildDir = resolve(desktopRoot, "build");
mkdirSync(buildDir, { recursive: true });

const COLORS = {
  main: "#e8743a",
  branchGreen: "#62c882",
  branchBlue: "#7aa2f7"
};

function svgFor(colors) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <g fill="none" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">
    <path d="M103 35 C84 35 84 64 64 64" stroke="${colors.branchBlue}" />
    <path d="M25 94 C44 94 44 108 64 108" stroke="${colors.branchGreen}" />
    <path d="M64 12 V116" stroke="${colors.main}" />
  </g>
  <g>
    <circle cx="64" cy="12" r="10" fill="${colors.main}" />
    <circle cx="64" cy="64" r="10" fill="${colors.main}" />
    <circle cx="64" cy="116" r="10" fill="${colors.main}" />
    <circle cx="103" cy="35" r="10" fill="${colors.branchBlue}" />
    <circle cx="25" cy="94" r="10" fill="${colors.branchGreen}" />
  </g>
</svg>
`.trim();
}

async function emit(svg, baseName, targetPx, suffix) {
  const out = resolve(buildDir, `${baseName}${suffix}.png`);
  await sharp(Buffer.from(svg), { density: 72 * (targetPx / 16) })
    .resize(targetPx, targetPx, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`wrote ${out}`);
}

const templateColors = { main: "black", branchGreen: "black", branchBlue: "black" };
const TEMPLATE_SVG = svgFor(templateColors);
const COLORED_SVG = svgFor(COLORS);

await Promise.all([
  // macOS menubar template: opaque black contributes only alpha; macOS applies
  // the actual dark/light/accent tint when the future tray feature loads it.
  emit(TEMPLATE_SVG, "tray-icon-template", 16, ""),
  emit(TEMPLATE_SVG, "tray-icon-template", 32, "@2x"),
  emit(TEMPLATE_SVG, "tray-icon-template", 48, "@3x"),
  // Windows and Linux have no template tinting, so carry the graph colors.
  emit(COLORED_SVG, "tray-icon", 16, ""),
  emit(COLORED_SVG, "tray-icon", 32, "@2x"),
  emit(COLORED_SVG, "tray-icon", 48, "@3x")
]);
