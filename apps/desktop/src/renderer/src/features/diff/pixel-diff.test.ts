import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pixelmatch from "pixelmatch";
import {
  DIFF_AA_COLOR,
  DIFF_COLOR,
  DIFF_OPTIONS,
  planDiff,
  type DiffReply,
  type DiffRequest
} from "./pixel-diff";

const RETINA = { w: 3104, h: 2024 };
const ONE_X = { w: 1552, h: 1012 };

describe("planDiff", () => {
  it("compares equal revisions as they are", () => {
    const plan = planDiff(RETINA, RETINA);
    expect(plan.size).toEqual(RETINA);
    expect(plan.mismatch).toBeNull();
  });

  it("scales a 2x export onto its 1x twin, at the larger size", () => {
    const plan = planDiff(RETINA, ONE_X);
    expect(plan.canStretch).toBe(true);
    expect(plan.fit).toBe("stretch");
    // Downscaling the bigger revision would resample the differences away —
    // which is the one thing this view exists not to do.
    expect(plan.size).toEqual(RETINA);
    expect(plan.mismatch).toEqual({ before: RETINA, after: ONE_X });
  });

  it("anchors two different shapes instead of distorting one into the other", () => {
    const plan = planDiff({ w: 800, h: 600 }, { w: 800, h: 400 });
    expect(plan.canStretch).toBe(false);
    expect(plan.fit).toBe("anchor");
    // The union box: what one revision does not cover compares as changed,
    // which is the truth about a crop.
    expect(plan.size).toEqual({ w: 800, h: 600 });
  });

  it("lets the caller override the shape's default either way", () => {
    expect(planDiff(RETINA, ONE_X, false).fit).toBe("anchor");
    expect(planDiff({ w: 800, h: 600 }, { w: 800, h: 400 }, true).fit).toBe(
      "stretch"
    );
  });

  it("treats a rounding-error aspect ratio as the same shape", () => {
    // 1553x1012 is not exactly half of 3104x2024, but it is the same picture.
    expect(planDiff(RETINA, { w: 1553, h: 1012 }).canStretch).toBe(true);
  });

  it("offers no toggle for a pair that is already the same size", () => {
    expect(planDiff(RETINA, RETINA).canStretch).toBe(false);
  });
});

describe("diff colors", () => {
  it("matches the tokens the legend swatches paint with", () => {
    // The worker bakes these numbers into the PNG while the swatches beside it
    // read CSS. Nothing else keeps the two in step, so this does.
    const here = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(
      resolve(here, "../../styles/tokens.css"),
      "utf8"
    );
    const rgbOf = (token: string): [number, number, number] => {
      const hex = tokens.match(
        new RegExp(`^\\s+${token}\\s*:\\s*#([0-9a-f]{6});`, "m")
      );
      if (hex === null) throw new Error(`missing token: ${token}`);
      const value = hex[1]!;
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16)
      ];
    };
    expect(DIFF_COLOR).toEqual(rgbOf("--diff-changed"));
    expect(DIFF_AA_COLOR).toEqual(rgbOf("--diff-aa"));
  });
});

/** An `w`x`h` RGBA buffer of one opaque colour. */
function fill(
  w: number,
  h: number,
  [r, g, b]: [number, number, number]
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data.set([r, g, b, 255], i * 4);
  }
  return data;
}

const pixelAt = (
  data: Uint8ClampedArray,
  w: number,
  x: number,
  y: number
): number[] => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 3));

describe("the comparison itself", () => {
  // The worker's other half needs OffscreenCanvas, so it cannot run here. This
  // half can, and it is the half where a renamed option would go unnoticed:
  // pixelmatch ignores keys it does not know and quietly uses its own defaults,
  // which would paint the deltas in ITS red instead of ours.
  const W = 8;
  const H = 8;

  it("counts only the pixels that changed", () => {
    const before = fill(W, H, [10, 10, 10]);
    const after = fill(W, H, [10, 10, 10]);
    after.set([255, 255, 255, 255], (2 * W + 3) * 4);
    after.set([255, 255, 255, 255], (5 * W + 6) * 4);

    const out = new Uint8ClampedArray(W * H * 4);
    expect(pixelmatch(before, after, out, W, H, DIFF_OPTIONS)).toBe(2);
  });

  it("paints the deltas in our colour, not pixelmatch's default red", () => {
    const before = fill(W, H, [10, 10, 10]);
    const after = fill(W, H, [10, 10, 10]);
    after.set([255, 255, 255, 255], (2 * W + 3) * 4);

    const out = new Uint8ClampedArray(W * H * 4);
    pixelmatch(before, after, out, W, H, DIFF_OPTIONS);

    expect(pixelAt(out, W, 3, 2)).toEqual(DIFF_COLOR);
    // Everything else is the original, faded — present enough to place the
    // change on the page, dim enough that the magenta wins the eye.
    const untouched = pixelAt(out, W, 0, 0);
    expect(untouched).not.toEqual(DIFF_COLOR);
    expect(Math.max(...untouched)).toBeLessThan(255);
  });

  it("reports a pair that did not change at all", () => {
    const same = fill(W, H, [200, 120, 40]);
    const out = new Uint8ClampedArray(W * H * 4);
    expect(pixelmatch(same, same.slice(), out, W, H, DIFF_OPTIONS)).toBe(0);
  });

  it("counts a smaller revision's missing corner as changed", () => {
    // What `anchor` produces: the overhang of the larger revision compares
    // against transparency, which is the truth about a crop.
    const before = fill(W, H, [200, 200, 200]);
    const after = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        after.set([200, 200, 200, 255], (y * W + x) * 4);
      }
    }
    const out = new Uint8ClampedArray(W * H * 4);
    expect(pixelmatch(before, after, out, W, H, DIFF_OPTIONS)).toBe(
      W * H - 4 * 4
    );
  });
});

describe("the worker boundary", () => {
  // The revisions cross to the worker as the Blobs the pane already holds —
  // a handle to the same bytes, not a copy — and the worker decodes them
  // directly. It used to be handed two data: URLs and fetch() them back into
  // the Blobs they had been made from.
  const before = new Blob([new Uint8Array([1])], { type: "image/png" });
  const after = new Blob([new Uint8Array([2])], { type: "image/png" });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("posts the two Blobs themselves to the worker", async () => {
    const posted: DiffRequest[] = [];
    class FakeWorker extends EventTarget {
      postMessage(message: DiffRequest): void {
        posted.push(message);
        const reply: DiffReply = {
          id: message.id,
          ok: true,
          png: new Blob(),
          changed: 3,
          total: 4
        };
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("message", { data: reply }))
        );
      }
      terminate(): void {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    const { computePixelDiff } = await import("./pixel-diff-client");

    const result = await computePixelDiff({
      before,
      after,
      width: 2,
      height: 2,
      fit: "anchor"
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.before).toBe(before);
    expect(posted[0]?.after).toBe(after);
    expect(result).toMatchObject({ changed: 3, total: 4 });
  });

  describe("inside the worker", () => {
    const W = 4;
    const H = 3;
    /** A decoded revision: one flat colour, and whether close() was called. */
    type FakeBitmap = { rgb: [number, number, number]; closed: boolean };
    let decodedFrom: Blob[];
    let bitmaps: FakeBitmap[];
    let fetchSpy: ReturnType<typeof vi.fn>;
    let scope: {
      onmessage: ((event: { data: DiffRequest }) => void) | null;
      postMessage: (reply: DiffReply) => void;
    };
    let replies: DiffReply[];

    beforeEach(async () => {
      decodedFrom = [];
      bitmaps = [];
      replies = [];
      fetchSpy = vi.fn();
      scope = { onmessage: null, postMessage: (reply) => replies.push(reply) };
      vi.stubGlobal("self", scope);
      vi.stubGlobal("fetch", fetchSpy);
      vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
        decodedFrom.push(blob);
        const bitmap: FakeBitmap = {
          rgb: blob === before ? [10, 10, 10] : [250, 250, 250],
          closed: false
        };
        bitmaps.push(bitmap);
        return { ...bitmap, close: () => (bitmap.closed = true) };
      });
      vi.stubGlobal(
        "ImageData",
        class {
          data: Uint8ClampedArray;
          constructor(w: number, h: number) {
            this.data = new Uint8ClampedArray(w * h * 4);
          }
        }
      );
      vi.stubGlobal(
        "OffscreenCanvas",
        class {
          private drawn: [number, number, number] = [0, 0, 0];
          constructor(
            private readonly w: number,
            private readonly h: number
          ) {}
          getContext() {
            return {
              drawImage: (bitmap: FakeBitmap) => (this.drawn = bitmap.rgb),
              getImageData: () => ({ data: fill(this.w, this.h, this.drawn) }),
              putImageData: () => undefined
            };
          }
          async convertToBlob() {
            return new Blob([new Uint8Array([0x89])], { type: "image/png" });
          }
        }
      );
      await import("./pixel-diff.worker");
    });

    async function run(request: DiffRequest): Promise<DiffReply> {
      scope.onmessage?.({ data: request });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      return replies[0]!;
    }

    it("decodes the posted Blobs directly, with no fetch", async () => {
      const reply = await run({ id: 7, before, after, width: W, height: H, fit: "anchor" });

      expect(decodedFrom).toEqual([before, after]);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Every pixel differs, so the count proves the decoded pair is what
      // pixelmatch compared.
      expect(reply).toMatchObject({ id: 7, ok: true, changed: W * H, total: W * H });
      // GPU-backed, released only by close().
      expect(bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
    });

    it("still closes the decoded side when the other cannot be decoded", async () => {
      vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
        if (blob === after) throw new Error("undecodable");
        const bitmap: FakeBitmap = { rgb: [10, 10, 10], closed: false };
        bitmaps.push(bitmap);
        return { ...bitmap, close: () => (bitmap.closed = true) };
      });

      const reply = await run({ id: 8, before, after, width: W, height: H, fit: "anchor" });

      expect(reply).toEqual({ id: 8, ok: false, error: "undecodable" });
      expect(bitmaps).toHaveLength(1);
      expect(bitmaps[0]?.closed).toBe(true);
    });
  });
});
