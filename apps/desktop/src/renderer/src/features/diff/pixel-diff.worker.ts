import pixelmatch from "pixelmatch";
import {
  DIFF_OPTIONS,
  type DiffReply,
  type DiffRequest
} from "./pixel-diff";

/**
 * The pixel comparison, off the UI thread. A pair of retina screenshots is
 * 6 megapixels a side, and pixelmatch's anti-aliasing pass walks every
 * neighbour of every differing pixel — long enough on the renderer's thread to
 * freeze the diff pane mid-scroll.
 *
 * Typed structurally rather than as a DedicatedWorkerGlobalScope so this file
 * compiles under the renderer's DOM lib without a second tsconfig.
 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<DiffRequest>) => void) | null;
  postMessage: (message: DiffReply) => void;
};

/** Above this a diff is minutes of work and gigabytes of buffers. */
const MAX_PIXELS = 40_000_000;

async function decode(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  return createImageBitmap(await response.blob());
}

function rasterize(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  fit: DiffRequest["fit"]
): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("no 2d context");
  if (fit === "stretch") {
    context.drawImage(bitmap, 0, 0, width, height);
  } else {
    // Natural size in the corner: whatever the smaller revision does not cover
    // stays transparent and compares as changed, which is the truth about it.
    context.drawImage(bitmap, 0, 0);
  }
  return context.getImageData(0, 0, width, height);
}

ctx.onmessage = (event: MessageEvent<DiffRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const { id, width, height, fit } = request;
      if (width * height > MAX_PIXELS) {
        throw new Error("image pair is too large to compare");
      }
      const [beforeBitmap, afterBitmap] = await Promise.all([
        decode(request.before),
        decode(request.after)
      ]);
      const before = rasterize(beforeBitmap, width, height, fit);
      const after = rasterize(afterBitmap, width, height, fit);
      beforeBitmap.close();
      afterBitmap.close();

      const output = new ImageData(width, height);
      const changed = pixelmatch(
        before.data,
        after.data,
        output.data,
        width,
        height,
        DIFF_OPTIONS
      );

      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");
      context.putImageData(output, 0, 0);
      const png = await canvas.convertToBlob({ type: "image/png" });
      ctx.postMessage({
        id,
        ok: true,
        png,
        changed,
        total: width * height
      });
    } catch (error) {
      ctx.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
};
