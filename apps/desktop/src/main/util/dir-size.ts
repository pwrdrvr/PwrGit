import { lstatSync, opendirSync, type Dirent, type Stats } from "node:fs";
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
 * - a **yield** every few directories when running on main, so IPC and
 *   other main-process work can proceed.
 *
 * Symlinks are never followed: their target may be outside the tree (a pnpm
 * store elsewhere on the disk) and counting it would attribute another
 * checkout's bytes to this one — or loop.
 *
 * **Hard links are counted once.** pnpm builds `node_modules` by hard-linking
 * one store blob into every package directory that needs it, so summing
 * `stat.size` per directory entry reports the same blocks over and over: a
 * checkout that really occupies a few hundred MB measures as several GB. Since
 * the number here becomes "freeing 4.2 GB" in a confirm the user is about to
 * act on, multiply-linked files are de-duplicated by `dev:ino` within one
 * walk. Links into the same file from *another* worktree are still counted
 * here, because from this root's point of view they are its bytes — what a
 * deletion actually returns to the filesystem is a floor, not this number.
 */
export const DIR_SIZE_ENTRY_CAP = 250_000;

/** Directories read between event-loop yields. */
const YIELD_EVERY_DIRS = 24;

/** Entries between cancellation checks, also the async stat batch size. */
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
  /** Multiply-linked files seen more than once, and so counted only once. */
  hardLinks: number;
  /** Latest filesystem change, populated only when trackActivity is requested. */
  lastTouchedAt?: string;
};

export type DirSizeOptions = {
  signal?: AbortSignal;
  entryCap?: number;
  trackActivity?: boolean;
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
  return walkDirectory(root, options, () => options.signal?.aborted === true);
}

/** Used in the prune worker, where blocking metadata calls avoid a libuv
 * round trip for each entry without blocking main. */
export function directorySizeInWorker(
  root: string,
  cancelled: Int32Array,
  entryCap = DIR_SIZE_ENTRY_CAP
): Promise<DirSizeResult> {
  return walkDirectory(
    root,
    { trackActivity: true, entryCap },
    () => Atomics.load(cancelled, 0) !== 0,
    true
  );
}

type ReadStats = (path: string) => Stats | Promise<Stats>;

function readWorkerDirectory(
  path: string,
  remaining: number,
  aborted: () => boolean
): Dirent[] {
  if (aborted()) return [];
  // Node may stat entries whose types the filesystem omitted. Bound that work
  // to one buffer per read, with a cancellation check before each read.
  const directory = opendirSync(path, { bufferSize: STAT_BATCH });
  const entries: Dirent[] = [];
  try {
    // Read one extra entry to distinguish a capped directory from exact EOF.
    while (entries.length <= remaining && !aborted()) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  return entries;
}

async function walkDirectory(
  root: string,
  { entryCap = DIR_SIZE_ENTRY_CAP, trackActivity = false }: DirSizeOptions,
  aborted: () => boolean,
  inWorker = false
): Promise<DirSizeResult> {
  const result: DirSizeResult = {
    bytes: 0,
    entries: 0,
    partial: false,
    inaccessible: 0,
    hardLinks: 0
  };
  // Only files with nlink > 1 are recorded, so the ordinary case costs nothing:
  // a tree with no hard links never puts a key in here.
  const seenLinks = new Set<string>();
  let lastTouchedMs = Number.NEGATIVE_INFINITY;
  const observe = (stats: Stats): void => {
    if (!trackActivity) return;
    // Reads/atime do not count. Metadata changes and creation do, including
    // checkouts of old commits and edits restored to their committed contents.
    const at = Math.max(stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs);
    if (Number.isFinite(at) && at > lastTouchedMs) lastTouchedMs = at;
  };
  const finish = (): DirSizeResult => {
    if (Number.isFinite(lastTouchedMs)) {
      result.lastTouchedAt = new Date(lastTouchedMs).toISOString();
    }
    return result;
  };
  const countFile = (stats: Stats): void => {
    observe(stats);
    if (!stats.isFile()) return;
    if (stats.nlink > 1) {
      const key = `${stats.dev}:${stats.ino}`;
      if (seenLinks.has(key)) {
        result.hardLinks += 1;
        return;
      }
      seenLinks.add(key);
    }
    result.bytes += stats.size;
  };
  const readStats: ReadStats = inWorker ? lstatSync : lstat;
  const stack: string[] = [root];
  let dirsRead = 0;

  while (stack.length > 0) {
    if (aborted()) {
      result.partial = true;
      return finish();
    }
    if (result.entries >= entryCap) {
      result.partial = true;
      return finish();
    }
    const dir = stack.pop() as string;
    let dirents;
    try {
      if (trackActivity) observe(await readStats(dir));
      dirents = inWorker
        ? readWorkerDirectory(dir, Math.ceil(entryCap - result.entries), aborted)
        : await readdir(dir, { withFileTypes: true });
    } catch {
      result.inaccessible += 1;
      continue;
    }
    dirsRead += 1;
    if (!inWorker && dirsRead % YIELD_EVERY_DIRS === 0) await yieldToEventLoop();

    if (inWorker && aborted()) {
      result.partial = true;
      return finish();
    }

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
      // Observe a symlink's own activity without following its target.
      if (dirent.isSymbolicLink()) {
        if (trackActivity) files.push(join(dir, dirent.name));
        continue;
      }
      if (dirent.isDirectory()) stack.push(join(dir, dirent.name));
      else if (dirent.isFile()) files.push(join(dir, dirent.name));
    }

    for (let at = 0; at < files.length; at += STAT_BATCH) {
      if (aborted()) {
        result.partial = true;
        return finish();
      }
      if (inWorker) {
        const end = Math.min(at + STAT_BATCH, files.length);
        for (let index = at; index < end; index += 1) {
          try {
            countFile(lstatSync(files[index]!));
          } catch {
            result.inaccessible += 1;
          }
        }
        continue;
      }
      const batch = await Promise.all(
        files.slice(at, at + STAT_BATCH).map((file) => lstat(file).catch(() => null))
      );
      for (const stats of batch) {
        if (stats === null) result.inaccessible += 1;
        else countFile(stats);
      }
    }
    // Sized what this directory had, then stop: `partial` is already set.
    if (result.partial) return finish();
  }
  return finish();
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
    return {
      bytes: 0,
      entries: 0,
      partial: false,
      inaccessible: 1,
      hardLinks: 0
    };
  }
  if (stats.isDirectory()) return directorySize(target, options);
  // A symlink's target is somebody else's bytes (see directorySize).
  const bytes = stats.isFile() ? stats.size : 0;
  return { bytes, entries: 1, partial: false, inaccessible: 0, hardLinks: 0 };
}
