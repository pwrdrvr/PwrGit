import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Measuring a checkout is measuring its `node_modules`, so this is the one
 * place in the app that walks an arbitrarily large tree. Three bounds keep it
 * from becoming a hang:
 *
 * - an **entry ceiling**, after which the answer is returned as a lower bound
 *   rather than kept growing (a pnpm store hard-linked into a monorepo can be
 *   millions of inodes, and "at least 4 GB" is the same decision as "4.2 GB");
 * - an **abort signal**, because the user must be able to cancel a sweep and
 *   have git and the filesystem both stop;
 * - a **yield** every few directories, so the main process keeps painting.
 *
 * Symlinks are never followed: their target may be outside the tree (a pnpm
 * store elsewhere on the disk) and counting it would attribute another
 * checkout's bytes to this one — or loop.
 */
export const DIR_SIZE_ENTRY_CAP = 250_000;

/** Directories read between event-loop yields. */
const YIELD_EVERY_DIRS = 24;

/** `lstat` calls issued at once within one directory. */
const STAT_BATCH = 32;

export type DirSizeResult = {
  /** Apparent size: summed `stat.size` of regular files, not blocks on disk.
   *  Chosen over `st_blocks` because Windows reports no block count at all. */
  bytes: number;
  /** Filesystem entries visited (files + directories). */
  entries: number;
  /** The entry ceiling or the signal stopped the walk: `bytes` is a floor. */
  partial: boolean;
  /** Entries that could not be read (permissions, or deleted mid-walk). */
  inaccessible: number;
};

export type DirSizeOptions = {
  signal?: AbortSignal;
  entryCap?: number;
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Sum the apparent size of everything under `root`, bounded and cancellable.
 *
 * A missing or unreadable root is not an error: the pruner sizes directories it
 * is about to propose deleting, and one going away underneath it is the
 * expected race, not a failure worth aborting a whole sweep for.
 */
export async function directorySize(
  root: string,
  options: DirSizeOptions = {}
): Promise<DirSizeResult> {
  const entryCap = options.entryCap ?? DIR_SIZE_ENTRY_CAP;
  const result: DirSizeResult = {
    bytes: 0,
    entries: 0,
    partial: false,
    inaccessible: 0
  };
  // Read through a call, not a property: `signal.aborted` is a readonly
  // boolean, so TypeScript narrows it permanently after the first check and
  // a later `=== true` reads as dead code — while the value really does flip
  // underneath us, which is the whole point of the check.
  const aborted = (): boolean => options.signal?.aborted === true;
  const stack: string[] = [root];
  let dirsRead = 0;

  while (stack.length > 0) {
    if (aborted()) {
      result.partial = true;
      return result;
    }
    if (result.entries >= entryCap) {
      result.partial = true;
      return result;
    }
    const dir = stack.pop() as string;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      result.inaccessible += 1;
      continue;
    }
    dirsRead += 1;
    if (dirsRead % YIELD_EVERY_DIRS === 0) await yieldToEventLoop();

    const files: string[] = [];
    for (const dirent of dirents) {
      // The ceiling is enforced per ENTRY, not per directory: one
      // `node_modules/.pnpm` can hold hundreds of thousands of children, so a
      // check that only ran between directories would sail straight past it.
      if (result.entries >= entryCap) {
        result.partial = true;
        break;
      }
      result.entries += 1;
      // A symlink is counted as an entry and nothing more — see the note above.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) stack.push(join(dir, dirent.name));
      else if (dirent.isFile()) files.push(join(dir, dirent.name));
    }

    for (let at = 0; at < files.length; at += STAT_BATCH) {
      if (aborted()) {
        result.partial = true;
        return result;
      }
      const sizes = await Promise.all(
        files.slice(at, at + STAT_BATCH).map(async (file) => {
          try {
            return (await lstat(file)).size;
          } catch {
            return null;
          }
        })
      );
      for (const size of sizes) {
        if (size === null) result.inaccessible += 1;
        else result.bytes += size;
      }
    }
    // Sized what this directory had, then stop: `partial` is already set.
    if (result.partial) return result;
  }
  return result;
}

/**
 * Size one path whose kind is not known yet — a `git clean` dry run reports
 * both files and directories, and the caller should not have to stat first.
 */
export async function pathSize(
  target: string,
  options: DirSizeOptions = {}
): Promise<DirSizeResult> {
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    return { bytes: 0, entries: 0, partial: false, inaccessible: 1 };
  }
  if (stats.isDirectory()) return directorySize(target, options);
  // A symlink's target is somebody else's bytes (see directorySize).
  const bytes = stats.isFile() ? stats.size : 0;
  return { bytes, entries: 1, partial: false, inaccessible: 0 };
}
