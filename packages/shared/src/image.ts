// Image previews for binary diffs. A repository's `.png`/`.gif`/`.webp` blobs
// carry no unified diff, so the diff pane fetches the bytes for each side and
// hands them to an <img>. Chromium already decodes every format below, which
// is why the app needs no image library — only a way to name the bytes.

const MEDIA_TYPES = new Map<string, string>([
  ["apng", "image/apng"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["ico", "image/x-icon"],
  ["jfif", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["webp", "image/webp"]
]);

/**
 * Media type for a path's extension, or null when the path is not an image
 * the renderer can display. Extension-based on purpose: Git tells us a blob is
 * binary but not what it is, and sniffing magic bytes in the main process
 * would still not cover the formats that share a container.
 */
export function imageMediaType(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return MEDIA_TYPES.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/**
 * Ceiling on a previewed blob. Base64 inflates by a third and the string is
 * copied across the IPC boundary, so a repository that keeps a 200 MB PSD-like
 * asset must not stall the renderer for a picture nobody can see anyway.
 */
export const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;

/** Which revision of a path to read the image bytes from. */
export type ImageRevision =
  | { kind: "worktree" }
  | { kind: "index" }
  | { kind: "head" }
  | { kind: "commit"; hash: string }
  | { kind: "commitParent"; hash: string };

/**
 * One side of an image diff. `missing` is the normal answer for the other side
 * of an add or a delete, not an error.
 */
export type ImagePreview =
  | { kind: "image"; mediaType: string; base64: string; bytes: number }
  | { kind: "missing" }
  | { kind: "tooLarge"; bytes: number }
  | { kind: "lfsPointer" };
