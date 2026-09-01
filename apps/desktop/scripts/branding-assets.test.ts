import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

/**
 * The shipped macOS app icon, as a test.
 *
 * `build/icon.icns` is a binary that no reviewer reads in a diff, and it is
 * the *only* icon macOS ever sees — electron-builder copies it into the
 * bundle verbatim. A container that decodes wrong therefore ships silently
 * and shows up as a broken icon in Finder and the Dock.
 *
 * That already happened once: the checked-in icns stored its 16px and 32px
 * artwork in `icp4`/`icp5` elements. Those are the ambiguous 10.7-era slots —
 * an ICNS writer may legally put PNG in them, but Apple's own CoreServices
 * decoder reads them as raw pixel data, so both small sizes came back as
 * colour noise (`iconutil -c iconset` on that file reproduces it). Every
 * larger size was fine, which is exactly why it went unnoticed.
 *
 * Regenerate with `pnpm --filter @pwrgit/desktop generate:app-icon`, which
 * renders `build/icon.iconset/` from `generate-app-icon.swift` and packs it
 * with `iconutil`. These tests assert the result of that pipeline, so a
 * hand-rolled or third-party icns writer fails here rather than in Finder.
 */

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "../build");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every element header is a 4-char type plus a 4-byte length. */
const ELEMENT_HEADER = 8;

/**
 * The elements `iconutil` emits for a complete iconset, each with the pixel
 * size it carries and the payload encoding its type implies. `ic04`/`ic05`
 * hold Apple's run-length-coded `ARGB` blobs; everything else holds PNG.
 */
const EXPECTED_ELEMENTS = {
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
} as const;

/** The slots CoreServices misreads. Never ship artwork in one. */
const FORBIDDEN_ELEMENTS = ["icp4", "icp5", "icp6"] as const;

/** Non-image trailer `iconutil` appends; carries a binary plist, not artwork. */
const METADATA_ELEMENTS = ["info", "TOC "] as const;

interface Element {
  type: string;
  payload: Buffer;
}

/** Walk the flat element table. An ICNS is `icns`, a big-endian byte count for
 *  the whole file, then `<4-char type><4-byte length incl. header><payload>`.
 *
 *  Every read is bounds-checked first: a truncated file is the likeliest way
 *  this goes wrong (an interrupted `iconutil`, a partial checkout), and
 *  `readUInt32BE` past the end throws `ERR_OUT_OF_RANGE`, which says nothing
 *  about the icns. Throw a sentence naming the problem instead. */
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
    // A length that under- or overruns would desynchronise every element after
    // it, so fail here rather than reporting nonsense types further down. That
    // also makes the walk terminate: length is always at least the header.
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
 * Square edge length of an `ARGB` element.
 *
 * There is no header to read — the size is implied by how much data the
 * payload decompresses to. Apple packs the four channels back to back with a
 * PackBits variant: a control byte with the high bit set repeats the next byte
 * `(c & 0x7f) + 3` times, otherwise the next `c + 1` bytes are literal. Four
 * channels of N x N pixels means 4 * N^2 bytes out.
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

// Parsed lazily and memoised: reading in a `describe` body turns a missing or
// malformed asset into a collection error, which registers no tests at all
// rather than failing the ones written to report it.
let parsed: Element[] | undefined;
const icnsElements = (): Element[] =>
  (parsed ??= readIcns(readFileSync(resolve(buildDir, "icon.icns"))));

describe("build/icon.icns", () => {
  it("carries no element type that CoreServices decodes as raw pixels", () => {
    const byType = new Set(icnsElements().map((element) => element.type));
    expect(
      FORBIDDEN_ELEMENTS.filter((type) => byType.has(type)),
      "icp4/icp5/icp6 render as colour noise at 16px and 32px — repack the " +
        "iconset with `pnpm --filter @pwrgit/desktop generate:app-icon`"
    ).toEqual([]);
  });

  it("carries every element iconutil emits for a full iconset", () => {
    const byType = new Set(icnsElements().map((element) => element.type));
    expect(Object.keys(EXPECTED_ELEMENTS).filter((type) => !byType.has(type))).toEqual([]);
  });

  it("holds artwork of the encoding and size each element type implies", () => {
    const byType = new Map(icnsElements().map((element) => [element.type, element]));
    for (const [type, { pixels, payload }] of Object.entries(EXPECTED_ELEMENTS)) {
      const element = byType.get(type);
      if (!element) continue; // reported by the coverage test above
      const measure = payload === "PNG" ? pngPixels : argbPixels;
      expect(measure(element.payload), `${type} artwork size`).toBe(pixels);
    }
  });

  it("contains nothing beyond the expected artwork and metadata", () => {
    const known = new Set<string>([...Object.keys(EXPECTED_ELEMENTS), ...METADATA_ELEMENTS]);
    expect(icnsElements().map((element) => element.type).filter((type) => !known.has(type)))
      .toEqual([]);
  });
});

describe("build/icon.iconset", () => {
  // `iconutil` derives every element from these, so a mis-sized source PNG
  // becomes a mis-sized element. Names encode the point size and scale.
  const sources = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024]
  ] as const;

  it.each(sources)("%s is %ipx square", (name, pixels) => {
    expect(pngPixels(readFileSync(resolve(buildDir, "icon.iconset", name)))).toBe(pixels);
  });

  it("keeps the macOS tile inside Apple's legacy safe area", async () => {
    const { data, info } = await sharp(resolve(buildDir, "icon.iconset", "icon_512x512@2x.png"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = info.width;
    let top = info.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alpha = data[(y * info.width + x) * info.channels + 3];
        if (alpha < 128) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }

    expect({
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1
    }).toEqual({ x: 100, y: 100, width: 824, height: 824 });
  });
});
