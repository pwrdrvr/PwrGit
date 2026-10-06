#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { isCliEntrypoint } from "../../../scripts/lib/cli-entrypoint.mjs";

// Standard hicolor sizes. The pinned builder preserves a PNG's dimensions
// instead of generating smaller icons, and hicolor does not list 1024x1024.
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

export async function generateLinuxIcons(buildDir) {
  const output = join(buildDir, "icons");
  mkdirSync(output, { recursive: true });
  for (const size of LINUX_ICON_SIZES) {
    await sharp(join(buildDir, "icon.png"))
      .resize(size, size)
      .png()
      .toFile(join(output, `${size}x${size}.png`));
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const buildDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../build"));
  await generateLinuxIcons(buildDir);
  console.log(`Generated Linux launcher icons in ${join(buildDir, "icons")}`);
}
