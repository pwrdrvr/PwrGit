import { dispatch } from "../../lib/pwrgit";
import type { Extent } from "./image-layout";

/**
 * Putting a revision — or several, side by side — on the system clipboard.
 *
 * Everything is re-encoded to PNG through a canvas rather than handing the
 * original bytes over. The repository's images can be webp, avif or gif, and
 * Electron's `nativeImage` decodes only PNG and JPEG; going through Chromium,
 * which already decoded the picture to show it, means every format the diff
 * pane can preview is also a format it can copy.
 */

export const STRIP_PAD = 16;
export const STRIP_GAP = 16;
/** Room above each panel for its "before" / "after" / "diff" label. */
export const STRIP_LABEL_BAND = 26;
/**
 * Panels are matched on height, and never scaled UP to reach it — a 1x export
 * beside its 2x twin should look soft-free, not interpolated. The cap keeps a
 * strip of retina screenshots from becoming a 30 MB clipboard payload.
 */
export const STRIP_MAX_HEIGHT = 2400;

export type StripBox = { x: number; y: number; w: number; h: number };

/**
 * Where each panel sits in a side-by-side strip. Pure, so the arithmetic that
 * decides the clipboard's contents can be checked without a canvas.
 */
export function stripLayout(panels: readonly Extent[]): {
  width: number;
  height: number;
  boxes: StripBox[];
} {
  const usable = panels.filter((panel) => panel.w > 0 && panel.h > 0);
  if (usable.length === 0) return { width: 0, height: 0, boxes: [] };

  const height = Math.min(
    STRIP_MAX_HEIGHT,
    Math.min(...usable.map((panel) => panel.h))
  );
  const boxes: StripBox[] = [];
  let x = STRIP_PAD;
  for (const panel of usable) {
    const scale = height / panel.h;
    const w = Math.round(panel.w * scale);
    boxes.push({ x, y: STRIP_PAD + STRIP_LABEL_BAND, w, h: height });
    x += w + STRIP_GAP;
  }
  return {
    // The trailing gap is not part of the picture.
    width: x - STRIP_GAP + STRIP_PAD,
    height: STRIP_PAD * 2 + STRIP_LABEL_BAND + height,
    boxes
  };
}

/** Reads a theme token, so a copied strip matches the app it came from. */
function token(name: string, fallback: string): string {
  if (typeof getComputedStyle === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value === "" ? fallback : value;
}

async function decode(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

/** One revision, re-encoded, with nothing added around it. */
export async function encodePng(src: string): Promise<Blob> {
  const image = await decode(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.drawImage(image, 0, 0);
  return toBlob(canvas);
}

export type StripPanel = { label: string; src: string };

/**
 * Several revisions in one picture, each captioned. Captions are the point: a
 * bare pair of screenshots pasted into a review tells nobody which one is the
 * "after".
 */
export async function composeStrip(
  panels: readonly StripPanel[]
): Promise<Blob> {
  const decoded = await Promise.all(panels.map((panel) => decode(panel.src)));
  // Drop the undrawable ones HERE, not inside stripLayout: it returns a box
  // per usable panel, so pairing its boxes with the original array by index
  // put every panel after a 0x0 one into its neighbour's slot.
  const drawable = decoded
    .map((image, i) => ({ image, panel: panels[i] }))
    .filter(
      (entry): entry is { image: HTMLImageElement; panel: StripPanel } =>
        entry.panel !== undefined &&
        entry.image.naturalWidth > 0 &&
        entry.image.naturalHeight > 0
    );
  const layout = stripLayout(
    drawable.map(({ image }) => ({
      w: image.naturalWidth,
      h: image.naturalHeight
    }))
  );
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");

  // Fallbacks are CSS system colors, not literals: they follow the OS light or
  // dark setting, where a hardcoded hex would bake this theme into a strip
  // copied from the other one. lint-renderer-colors.mjs is CSS-only and says
  // so — colors in .ts are the manual pass it delegates.
  context.fillStyle = token("--bg-panel", "Canvas");
  context.fillRect(0, 0, layout.width, layout.height);
  context.fillStyle = token("--text-secondary", "CanvasText");
  context.font = `600 15px ${token("--font-sans", "sans-serif")}`;
  context.textBaseline = "alphabetic";

  layout.boxes.forEach((box, i) => {
    const entry = drawable[i];
    if (entry === undefined) return;
    context.fillText(entry.panel.label, box.x, STRIP_PAD + STRIP_LABEL_BAND - 8);
    context.drawImage(entry.image, box.x, box.y, box.w, box.h);
  });
  return toBlob(canvas);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("could not encode the image"));
      else resolve(blob);
    }, "image/png");
  });
}

/**
 * Base64 in chunks. `String.fromCharCode(...bytes)` on a multi-megabyte PNG
 * overflows the argument list and throws, which would only ever show up on the
 * large screenshots this feature exists for.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Hands the PNG to the main process, which owns the system clipboard. */
export async function copyPngToClipboard(png: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  const result = await dispatch("clipboard:writeImage", {
    pngBase64: toBase64(bytes)
  });
  return result.ok;
}
