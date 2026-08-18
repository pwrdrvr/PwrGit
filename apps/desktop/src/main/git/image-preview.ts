import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  err,
  imageMediaType,
  MAX_IMAGE_PREVIEW_BYTES,
  ok,
  type ImagePreview,
  type ImageRevision,
  type Result
} from "@pwrgit/shared";
import type { GitExec, GitExecBinary } from "./dugite";

/** Git LFS replaces the blob with a small text pointer; `git show` hands back
 *  the pointer, not the picture, because it does not run smudge filters. */
const LFS_POINTER_PREFIX = "version https://git-lfs";

/** How much of a blob is enough to recognise an LFS pointer. */
const LFS_SNIFF_BYTES = 64;

/** `<rev>:<path>` for the revisions git can resolve; null means the working
 *  tree, which is a file on disk rather than an object. */
function revSpec(rev: ImageRevision, path: string): string | null {
  switch (rev.kind) {
    case "worktree":
      return null;
    case "index":
      return `:${path}`;
    case "head":
      return `HEAD:${path}`;
    case "commit":
      return `${rev.hash}:${path}`;
    case "commitParent":
      return `${rev.hash}^:${path}`;
  }
}

function isLfsPointer(bytes: Buffer): boolean {
  return bytes.subarray(0, LFS_SNIFF_BYTES).toString("latin1").startsWith(
    LFS_POINTER_PREFIX
  );
}

function preview(mediaType: string, bytes: Buffer): ImagePreview {
  if (isLfsPointer(bytes)) return { kind: "lfsPointer" };
  return {
    kind: "image",
    mediaType,
    base64: bytes.toString("base64"),
    bytes: bytes.byteLength
  };
}

/** Reject a path that escapes the worktree before it reaches the filesystem —
 *  the channel exists to show a diff, not to read arbitrary files. */
function insideWorktree(cwd: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const full = resolve(cwd, path);
  const rel = relative(resolve(cwd), full);
  // Only a leading `..` SEGMENT escapes — a plain `startsWith("..")` would
  // also reject a file that merely begins with two dots (`..cover.png`).
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return full;
}

async function worktreePreview(
  cwd: string,
  path: string,
  mediaType: string
): Promise<Result<ImagePreview>> {
  const full = insideWorktree(cwd, path);
  if (full === null) {
    return err({
      kind: "validation",
      code: "path_outside_worktree",
      message: "Path escapes the worktree"
    });
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) return ok({ kind: "missing" });
    if (info.size > MAX_IMAGE_PREVIEW_BYTES) {
      return ok({ kind: "tooLarge", bytes: info.size });
    }
    return ok(preview(mediaType, await readFile(full)));
  } catch {
    // A path that vanished between `git status` and this read is the other
    // side of a delete, not a failure worth surfacing.
    return ok({ kind: "missing" });
  }
}

/**
 * Bytes of one side of an image diff. A path that does not exist at the
 * requested revision — the "before" of an add, the "after" of a delete —
 * resolves to `missing`, so callers can ask for both sides unconditionally.
 */
export async function readImagePreview(
  git: GitExec,
  gitBinary: GitExecBinary,
  cwd: string,
  path: string,
  rev: ImageRevision
): Promise<Result<ImagePreview>> {
  const mediaType = imageMediaType(path);
  if (mediaType === null) {
    return err({
      kind: "validation",
      code: "not_an_image",
      message: `${path} is not a previewable image`
    });
  }

  const spec = revSpec(rev, path);
  if (spec === null) return worktreePreview(cwd, path, mediaType);

  // Size first: `cat-file -s` is a header read, so an oversized asset never
  // gets buffered just to be refused.
  const sized = await git(["cat-file", "-s", spec], cwd);
  if (!sized.ok) return sized;
  if (sized.value.exitCode !== 0) return ok({ kind: "missing" });
  const bytes = Number.parseInt(sized.value.stdout.trim(), 10);
  if (!Number.isFinite(bytes)) return ok({ kind: "missing" });
  if (bytes > MAX_IMAGE_PREVIEW_BYTES) return ok({ kind: "tooLarge", bytes });

  const blob = await gitBinary(["cat-file", "blob", spec], cwd);
  if (!blob.ok) return blob;
  if (blob.value.exitCode !== 0) return ok({ kind: "missing" });
  return ok(preview(mediaType, blob.value.stdout));
}
