import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The shipped macOS app icon, as a test.
 *
 * macOS reads the icon from two places, one per era:
 *
 *   - `Contents/Resources/Assets.car` + `CFBundleIconName` — macOS 26. Compiled
 *     by `actool` from `build/icon.icon`, the Icon Composer package that
 *     `generate-app-icon.swift` writes.
 *   - `Contents/Resources/icon.icns` + `CFBundleIconFile` — macOS 15 and
 *     earlier. Also actool output, derived from the same package.
 *
 * Nothing in this repo hand-builds a `.icns` any more. Two shipped bugs are
 * the reason, and both are asserted against below:
 *
 *   - #125: a hand-assembled icns stored its 16px and 32px artwork in
 *     `icp4`/`icp5`, the ambiguous 10.7-era slots that CoreServices decodes
 *     as raw pixels — both small sizes rendered as colour noise. actool's
 *     icns is checked for those slots here so a regression in Apple's
 *     writer is caught rather than shipped.
 *   - #187 padded the hand-built icns to Apple's 824-in-1024 template, which
 *     is right for macOS 15 — and macOS 26.6.2, handed ONLY that legacy
 *     icns, composited the padded tile onto a light plate in the Dock and
 *     Finder. With the `.icon` present macOS 26 never opens the icns, so the
 *     padding stays where it belongs.
 *
 * Regenerate with `pnpm --filter @pwrgit/desktop generate:app-icon`. The
 * package structure and the flat PNG masters are pinned everywhere; the
 * actool compile runs on a Mac with Xcode 26+ (electron-builder's own
 * requirement) and skips elsewhere.
 */

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "../build");
const iconPackage = join(buildDir, "icon.icon");
const glyphPng = join(iconPackage, "Assets", "glyph.png");
const flatMaster = join(buildDir, "icon.png");
const developmentDockIcon = join(buildDir, "icon-macos.png");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every element header is a 4-char type plus a 4-byte length. */
const ELEMENT_HEADER = 8;

/**
 * Pixel size and payload encoding each ICNS element type implies. `ic04`/
 * `ic05` hold Apple's run-length-coded `ARGB` blobs; everything else holds
 * PNG. actool emits a subset of these (16, 16@2x, 128, 256@2x today).
 */
const ELEMENT_TYPES: Record<string, { pixels: number; payload: "ARGB" | "PNG" }> = {
  ic04: { pixels: 16, payload: "ARGB" },
  ic05: { pixels: 32, payload: "ARGB" },
  ic11: { pixels: 32, payload: "PNG" },
  ic12: { pixels: 64, payload: "PNG" },
  ic07: { pixels: 128, payload: "PNG" },
  ic13: { pixels: 256, payload: "PNG" },
  ic08: { pixels: 256, payload: "PNG" },
  ic14: { pixels: 512, payload: "PNG" },
  ic09: { pixels: 512, payload: "PNG" },
  ic10: { pixels: 1024, payload: "PNG" }
};

/** The slots CoreServices misreads. Never ship artwork in one. */
const FORBIDDEN_ELEMENTS = ["icp4", "icp5", "icp6"] as const;

/** Non-image trailers; carry a binary plist or a table of contents, not artwork. */
const METADATA_ELEMENTS = ["info", "TOC "] as const;

interface Element {
  type: string;
  payload: Buffer;
}

/** Walk the flat element table. An ICNS is `icns`, a big-endian byte count for
 *  the whole file, then `<4-char type><4-byte length incl. header><payload>`.
 *
 *  Every read is bounds-checked first: a truncated file is the likeliest way
 *  this goes wrong, and `readUInt32BE` past the end throws `ERR_OUT_OF_RANGE`,
 *  which says nothing about the icns. Throw a sentence naming the problem. */
function readIcns(bytes: Buffer): Element[] {
  if (bytes.byteLength < ELEMENT_HEADER) {
    throw new Error(`truncated icns: ${bytes.byteLength} bytes, need at least ${ELEMENT_HEADER}`);
  }
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("icns");
  expect(bytes.readUInt32BE(4), "header byte count").toBe(bytes.byteLength);

  const elements: Element[] = [];
  let offset = ELEMENT_HEADER;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < ELEMENT_HEADER) {
      throw new Error(
        `truncated icns: ${bytes.byteLength - offset} trailing bytes cannot hold an element header`
      );
    }
    const type = bytes.subarray(offset, offset + 4).toString("latin1");
    const length = bytes.readUInt32BE(offset + 4);
    if (length < ELEMENT_HEADER || offset + length > bytes.byteLength) {
      throw new Error(
        `element ${type} declares ${length} bytes at offset ${offset}, ` +
          `outside a ${bytes.byteLength}-byte file`
      );
    }
    elements.push({ type, payload: bytes.subarray(offset + ELEMENT_HEADER, offset + length) });
    offset += length;
  }
  return elements;
}

/** Square edge length from a PNG's IHDR, which always leads the chunk list. */
function pngPixels(payload: Buffer): number {
  expect(payload.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(payload.subarray(12, 16).toString("latin1")).toBe("IHDR");
  const width = payload.readUInt32BE(16);
  const height = payload.readUInt32BE(20);
  expect(width).toBe(height);
  return width;
}

/**
 * Square edge length of an `ARGB` element. There is no header to read — the
 * size is implied by how much data the payload decompresses to. Apple packs
 * the four channels back to back with a PackBits variant: a control byte with
 * the high bit set repeats the next byte `(c & 0x7f) + 3` times, otherwise
 * the next `c + 1` bytes are literal. Four channels of N x N pixels means
 * 4 * N^2 bytes out.
 */
function argbPixels(payload: Buffer): number {
  expect(payload.subarray(0, 4).toString("latin1")).toBe("ARGB");

  let decoded = 0;
  let offset = 4;
  while (offset < payload.byteLength) {
    const control = payload[offset];
    offset += 1;
    if (control & 0x80) {
      decoded += (control & 0x7f) + 3;
      offset += 1; // the byte to repeat
    } else {
      decoded += control + 1;
      offset += control + 1;
    }
  }
  expect(offset, "ARGB run-length data overruns its payload").toBe(payload.byteLength);
  expect(decoded % 4, "ARGB data is not a whole number of pixels").toBe(0);

  const pixels = Math.sqrt(decoded / 4);
  expect(Number.isInteger(pixels), `ARGB data decodes to ${decoded / 4} pixels, not a square`)
    .toBe(true);
  return pixels;
}

interface AlphaImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/** Decodes a PNG (path or bytes) to raw RGBA. */
async function loadAlpha(input: string | Buffer): Promise<AlphaImage> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function alphaAt(image: AlphaImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * image.channels + 3];
}

/** Bounding box of pixels with alpha >= 128, or null when fully transparent. */
function opaqueBounds(image: AlphaImage): { x: number; y: number; width: number; height: number } | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(image, x, y) < 128) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

interface IconManifest {
  fill: { "linear-gradient": string[] };
  groups: Array<{ layers: Array<{ "image-name": string }> }>;
  "supported-platforms": { squares: string };
}

describe("build/icon.icon (Icon Composer package)", () => {
  const manifest = JSON.parse(readFileSync(join(iconPackage, "icon.json"), "utf8")) as IconManifest;

  it("paints the tile with a two-stop sRGB gradient from the generator's palette", () => {
    const stops = manifest.fill["linear-gradient"];
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      expect(stop).toMatch(/^srgb:\d\.\d{5},\d\.\d{5},\d\.\d{5},1\.00000$/);
    }
    expect(manifest["supported-platforms"].squares).toBe("shared");
  });

  it("references only layer images that exist in Assets/", () => {
    const imageNames = manifest.groups.flatMap((group) => group.layers.map((layer) => layer["image-name"]));
    expect(imageNames.length).toBeGreaterThan(0);
    for (const name of imageNames) {
      expect(existsSync(join(iconPackage, "Assets", name)), `missing Assets/${name}`).toBe(true);
    }
  });

  it("ships the mark alone, on a transparent 1024px canvas, inside the safe area", async () => {
    const glyph = await loadAlpha(glyphPng);
    expect({ width: glyph.width, height: glyph.height }).toEqual({ width: 1024, height: 1024 });

    // No baked tile: every corner and edge midpoint is fully transparent.
    for (const [x, y] of [
      [0, 0],
      [1023, 0],
      [0, 1023],
      [1023, 1023],
      [512, 0],
      [512, 1023],
      [0, 512],
      [1023, 512]
    ] as const) {
      expect(alphaAt(glyph, x, y), `alpha at ${x},${y}`).toBe(0);
    }

    // The mark stays inside Apple's 824-in-1024 safe area so nothing is
    // clipped by the icon shape on any platform.
    const bounds = opaqueBounds(glyph);
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(100);
    expect(bounds!.y).toBeGreaterThanOrEqual(100);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(924);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(924);
  });
});

describe("flat PNG masters", () => {
  it("keeps the development Dock icon's tile inside Apple's legacy safe area", async () => {
    // app.dock.setIcon() in src/main/index.ts paints this literally.
    expect(opaqueBounds(await loadAlpha(developmentDockIcon))).toEqual({
      x: 100,
      y: 100,
      width: 824,
      height: 824
    });
  });

  it("keeps the Windows / Linux master full-bleed", async () => {
    // electron-builder derives the .ico from this; neither platform wants a margin.
    expect(opaqueBounds(await loadAlpha(flatMaster))).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 1024
    });
  });
});

/**
 * Major version of the selected Xcode's actool, or 0 when unavailable.
 * electron-builder refuses to compile a .icon with anything below 26.
 */
function actoolMajorVersion(): number {
  if (process.platform !== "darwin") return 0;
  try {
    const plist = execFileSync("xcrun", ["actool", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"]
    });
    const short = (JSON.parse(json) as Record<string, Record<string, string>>)["com.apple.actool.version"][
      "short-bundle-version"
    ];
    return Number.parseInt(String(short).split(".")[0], 10) || 0;
  } catch {
    return 0;
  }
}

const actoolMajor = actoolMajorVersion();

describe.skipIf(actoolMajor < 26)("actool compile (macOS with Xcode 26+)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pwrgit-icon-compile-"));
  // electron-builder copies the package to `Icon.icon` before compiling:
  // actool resolves `--app-icon Icon` by the package's basename and, fed the
  // repo's `icon.icon` directly, exits 0 while silently emitting no icns. It
  // also does not create its --compile directory. Mirror both so a package
  // that passes here is exactly what packages at release time.
  const stagedPackage = join(tempDir, "Icon.icon");
  const outputDir = join(tempDir, "out");
  const partialPlist = join(outputDir, "assetcatalog_generated_info.plist");
  const generatedIcns = join(outputDir, "Icon.icns");
  cpSync(iconPackage, stagedPackage, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    "compiles to Assets.car plus a legacy icns, declaring both Info.plist keys",
    () => {
      // The exact invocation app-builder-lib/out/util/macosIconComposer.js
      // uses. The "Accent color 'AccentColor' is not present" notice is expected.
      execFileSync(
        "actool",
        [
          stagedPackage,
          "--compile",
          outputDir,
          "--output-format",
          "human-readable-text",
          "--notices",
          "--warnings",
          "--output-partial-info-plist",
          partialPlist,
          "--app-icon",
          "Icon",
          "--include-all-app-icons",
          "--accent-color",
          "AccentColor",
          "--enable-on-demand-resources",
          "NO",
          "--development-region",
          "en",
          "--target-device",
          "mac",
          "--minimum-deployment-target",
          "26.0",
          "--platform",
          "macosx"
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );

      expect(existsSync(join(outputDir, "Assets.car"))).toBe(true);
      expect(existsSync(generatedIcns)).toBe(true);

      // CFBundleIconName is what macOS 26 reads, CFBundleIconFile is what
      // macOS 15 falls back to. electron-builder writes the same pair.
      const plistJson = execFileSync("plutil", ["-convert", "json", "-o", "-", partialPlist], {
        encoding: "utf8"
      });
      expect(JSON.parse(plistJson)).toMatchObject({
        CFBundleIconName: "Icon",
        CFBundleIconFile: "Icon"
      });
    },
    120_000
  );

  it("writes a legacy icns CoreServices can decode at every size", () => {
    const elements = readIcns(readFileSync(generatedIcns));
    const byType = new Set(elements.map((element) => element.type));
    expect(
      FORBIDDEN_ELEMENTS.filter((type) => byType.has(type)),
      "icp4/icp5/icp6 render as colour noise at 16px and 32px (#125)"
    ).toEqual([]);

    const artwork = elements.filter((element) => !(METADATA_ELEMENTS as readonly string[]).includes(element.type));
    expect(artwork.length, "actool icns carries no artwork").toBeGreaterThan(0);
    for (const element of artwork) {
      const spec = ELEMENT_TYPES[element.type];
      expect(spec, `unexpected icns element ${element.type}`).toBeDefined();
      const measure = spec.payload === "PNG" ? pngPixels : argbPixels;
      expect(measure(element.payload), `${element.type} artwork size`).toBe(spec.pixels);
    }
  });

  it("pads the legacy icns the way macOS 15 expects", async () => {
    // actool, not this repo, decides the legacy inset now. Pin that it still
    // lands on Apple's 824-in-1024 template (~80.5% fill) — the reason the
    // hand-built, padded icns could be deleted at all.
    const largest = readIcns(readFileSync(generatedIcns))
      .filter((element) => ELEMENT_TYPES[element.type]?.payload === "PNG")
      .reduce((best, element) => (ELEMENT_TYPES[element.type].pixels > ELEMENT_TYPES[best.type].pixels ? element : best));
    const image = await loadAlpha(largest.payload);
    const bounds = opaqueBounds(image);
    expect(bounds).not.toBeNull();
    const fill = bounds!.width / image.width;
    expect(fill).toBeGreaterThan(0.78);
    expect(fill).toBeLessThan(0.83);
  });
});
