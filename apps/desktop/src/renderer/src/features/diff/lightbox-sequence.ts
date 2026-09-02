import { imageMediaType } from "@pwrgit/shared";
import type { DiffFile } from "./parse-diff";

export type SideKey = "before" | "after";
export type ItemKind = SideKey | "diff";

/** One position in the walk: which image file, and which of its items. */
export type Stop = { fileIndex: number; item: ItemKind };

/**
 * Which sides are worth fetching. An added file has no "before"; neither does
 * a rename out of a non-image extension (`logo.bin` → `logo.png`), where the
 * old blob is not something an <img> can show.
 */
export function sidesFor(
  status: DiffFile["status"],
  beforePath: string
): SideKey[] {
  if (status === "deleted") return ["before"];
  if (status === "added" || imageMediaType(beforePath) === null) {
    return ["after"];
  }
  return ["before", "after"];
}

/** The files the lightbox can walk — the same ones the viewer previews. */
export function imageFilesOf(files: readonly DiffFile[]): DiffFile[] {
  return files.filter(
    (file) => file.binary && imageMediaType(file.path) !== null
  );
}

/**
 * What one file contributes to the walk. Derived from its status rather than
 * from what has been fetched, so the sequence is complete before a single byte
 * of the next file has been read — the arrows cannot wait on IPC to know
 * whether there is anywhere further to go.
 *
 * A side that turns out to be unreadable (an LFS pointer, or bytes over the
 * preview ceiling) still occupies its stop and says so when you arrive. That
 * is better than a walk whose length changes underneath you as it loads.
 */
export function itemsForFile(file: DiffFile): ItemKind[] {
  const sides = sidesFor(file.status, file.oldPath ?? file.path);
  return sides.length === 2 ? ["before", "after", "diff"] : sides;
}

/**
 * Every stop across every image file, in the order the diff lists them. The
 * arrows step through this one flat list, so they run Before → After → Diff and
 * then straight into the next file's Before without the reader doing anything
 * different at the boundary.
 */
export function buildSequence(files: readonly DiffFile[]): Stop[] {
  return files.flatMap((file, fileIndex) =>
    itemsForFile(file).map((item) => ({ fileIndex, item }))
  );
}

/** Where a given file/item sits in the walk, or 0 when it is not in it. */
export function indexOfStop(sequence: readonly Stop[], stop: Stop): number {
  const at = sequence.findIndex(
    (candidate) =>
      candidate.fileIndex === stop.fileIndex && candidate.item === stop.item
  );
  return at === -1 ? 0 : at;
}

/**
 * Stepping, clamped at both ends. Deliberately no wrap-around: reaching the
 * last diff of the last file and having the arrow do nothing is how you learn
 * you are at the end. A walk that loops silently starts you over instead.
 */
export function stepStop(
  sequence: readonly Stop[],
  at: number,
  by: number
): number {
  // Lower bound last: with an empty sequence the upper bound is -1, and
  // returning that would hand a caller a position that is not one.
  return Math.max(0, Math.min(sequence.length - 1, at + by));
}
