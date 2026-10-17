import * as FSP from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { IterableMapper } from "./map-limit";
import { delay } from "./timing";

/**
 * Delete a directory tree one entry at a time, four at once, without ever
 * blocking the main process — ported from DiskHound's `permanentlyDeleteOnDisk`, on the same
 * p-map-iterable mapper (through `map-limit.ts`).
 *
 * Why not `rm -r`: `fs.rmSync` blocks the event loop for the whole walk, and
 * with `maxRetries` it also *sleeps* on the main thread between attempts — the
 * 2026-10-16 beachball was ~34s of exactly that. `fs.promises.rm` stays off the
 * main thread but reports nothing until it is done. Streaming individual
 * unlink/rmdir calls through a bounded mapper keeps the app live and lets the
 * caller show the delete moving.
 *
 * Read-only directories are made writable before their entries are removed.
 * Go writes its module cache 0555, so a checkout that ran `go` with a GOPATH
 * inside it cannot be emptied otherwise — `git worktree remove` fails on it
 * with "Permission denied", and so does `rm -rf`. Only directories are
 * chmodded, only after `lstat` says they are real directories (never a link's
 * target), and only to add the owner's rwx: everything chmodded is about to be
 * deleted.
 */

const PREFETCH_OPTIONS = { concurrency: 1, maxUnread: 100 };
const MAPPER_OPTIONS = { concurrency: 4, maxUnread: 100 };
const PROGRESS_MS = 150;
/** Windows holds fresh files briefly (antivirus, a probe's cwd); retry those.
 *  Ten attempts at 100ms × attempt is ~4.5s — the budget `git worktree
 *  remove` was given for the same locks before this replaced it. */
const MAX_ATTEMPTS = 10;
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY"]);

export type DeleteTreeProgress = {
  /** Files, links and directories removed so far. */
  itemsDeleted: number;
  /** The entry most recently removed. */
  path: string;
};

/** A delete that stopped partway: what stopped it, and how far it got. */
export class DeleteTreeError extends Error {
  readonly code: string | undefined;
  /** `path` relative to the root, for messages ("" for the root itself). */
  readonly relativePath: string;

  constructor(
    readonly root: string,
    readonly path: string,
    cause: unknown,
    readonly itemsDeleted: number
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`could not delete ${path}: ${reason}`, { cause });
    this.name = "DeleteTreeError";
    this.code = errorCode(cause);
    this.relativePath = relative(root, path);
  }
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const isMissing = (error: unknown): boolean => errorCode(error) === "ENOENT";

/**
 * Add the owner's rwx to a real directory; false if that did not happen.
 * `stat` is the caller's own lstat when it has one, so the walk pays one
 * lstat per directory, not two.
 */
async function makeWritable(
  path: string,
  stat?: { mode: number; isDirectory(): boolean }
): Promise<boolean> {
  try {
    const seen = stat ?? (await FSP.lstat(path));
    if (!seen.isDirectory()) return false;
    if ((seen.mode & 0o700) === 0o700) return false;
    await FSP.chmod(path, (seen.mode & 0o7777) | 0o700);
    return true;
  } catch {
    return false;
  }
}

/**
 * `parent` is the directory holding `path` inside the tree being deleted, or
 * null for the root itself: the root's parent is not ours to chmod.
 */
async function removeEntry(
  path: string,
  directory: boolean,
  parent: string | null
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (directory) await FSP.rmdir(path);
      else await FSP.unlink(path); // Includes symlinks and Windows junctions.
      return;
    } catch (error) {
      if (isMissing(error)) return;
      if (attempt >= MAX_ATTEMPTS) throw error;
      const code = errorCode(error) ?? "";
      if (code === "EACCES" || code === "EPERM") {
        if (process.platform === "win32") {
          // A read-only attribute blocks deletion on Windows. Never chmod a
          // link's target.
          try {
            const stat = await FSP.lstat(path);
            if (stat.isSymbolicLink()) throw error;
            await FSP.chmod(path, directory ? 0o777 : 0o666);
          } catch (fixError) {
            if (isMissing(fixError)) return;
            if (fixError !== error) throw fixError;
            // Locked rather than read-only: fall through to the backoff.
          }
        } else if (parent === null || !(await makeWritable(parent))) {
          // The walk already opened `parent` writable; a refusal now is a
          // flag (uchg), ownership or a sandbox, and retrying cannot fix it.
          throw error;
        }
      } else if (!RETRYABLE.has(code)) {
        throw error;
      }
      await delay(100 * attempt);
    }
  }
}

type DirectoryFrame = {
  path: string;
  handle: Awaited<ReturnType<typeof FSP.opendir>> | null;
  pending: number;
  ready?: () => void;
};

type Removal = { path: string; directory: boolean; parent?: DirectoryFrame };

/**
 * Remove `target` and everything under it. Resolves when it is gone (or was
 * never there); rejects with a `DeleteTreeError` naming the entry that stopped
 * it. Entries removed before the failure stay removed.
 *
 * `deleteLast` names files directly under `target` that go only after
 * everything else has: a worktree's `.git` link, so a delete that stops
 * partway leaves something Git still recognises as the worktree.
 *
 * The traversal is depth-first through one opendir buffer per level; a parent
 * becomes eligible only after its children settle, and a waiting parent never
 * holds a mapper slot. Memory grows with depth plus the bounded queues, not
 * with the size of the tree.
 */
export async function deleteTree(
  target: string,
  onProgress?: (progress: DeleteTreeProgress) => void,
  options: { deleteLast?: readonly string[] } = {}
): Promise<void> {
  const root = resolve(target);
  const lastNames = new Set(options.deleteLast ?? []);
  let itemsDeleted = 0;
  let failed = false;
  let failure: DeleteTreeError | null = null;
  const fail = (path: string, cause: unknown): void => {
    if (!failed) {
      failure =
        cause instanceof DeleteTreeError
          ? cause
          : new DeleteTreeError(root, path, cause, itemsDeleted);
    }
    failed = true;
  };

  async function openDirectory(
    path: string
  ): Promise<DirectoryFrame | "file" | null> {
    try {
      // Recheck before descending, and never follow a directory link or
      // junction: removing one removes the link, not what it points at.
      const stat = await FSP.lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "file";
      if (process.platform !== "win32") await makeWritable(path, stat);
      return {
        path,
        handle: await FSP.opendir(path, { bufferSize: 32 }),
        pending: 0
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new DeleteTreeError(root, path, error, itemsDeleted);
    }
  }

  async function close(frame: DirectoryFrame): Promise<void> {
    const handle = frame.handle;
    frame.handle = null;
    if (handle !== null) await handle.close();
  }

  /** Wait until every removal already handed out under `frame` settles. */
  async function settle(frame: DirectoryFrame): Promise<void> {
    if (frame.pending > 0 && !failed) {
      await new Promise<void>((done) => {
        frame.ready = done;
      });
    }
  }

  async function* source(): AsyncGenerator<Removal> {
    const stack: DirectoryFrame[] = [];
    const deferred: string[] = [];
    try {
      const top = await openDirectory(root);
      if (top === null) return;
      if (top === "file") {
        yield { path: root, directory: false };
        return;
      }
      stack.push(top);
      while (stack.length > 0 && !failed) {
        const frame = stack[stack.length - 1]!;
        let entry;
        try {
          entry = await frame.handle!.read();
        } catch (error) {
          if (!isMissing(error)) {
            throw new DeleteTreeError(root, frame.path, error, itemsDeleted);
          }
          entry = null;
        }
        if (failed) break;
        if (entry !== null) {
          const path = join(frame.path, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            const child = await openDirectory(path);
            if (child === null) continue;
            if (child !== "file") {
              frame.pending += 1;
              stack.push(child);
              continue;
            }
          }
          if (stack.length === 1 && lastNames.has(entry.name)) {
            deferred.push(path);
            continue;
          }
          frame.pending += 1;
          yield { path, directory: false, parent: frame };
        } else {
          await close(frame);
          await settle(frame);
          if (failed) break;
          if (stack.length === 1 && deferred.length > 0) {
            for (const path of deferred.splice(0)) {
              frame.pending += 1;
              yield { path, directory: false, parent: frame };
            }
            await settle(frame);
            if (failed) break;
          }
          stack.pop();
          const parent = stack[stack.length - 1];
          yield {
            path: frame.path,
            directory: true,
            ...(parent === undefined ? {} : { parent })
          };
        }
      }
    } catch (error) {
      // Never let the source throw: the mapper could reject before the
      // removals in flight settle. Record it, end the source, drain.
      fail(root, error);
    } finally {
      while (stack.length > 0) {
        const frame = stack.pop()!;
        try {
          await close(frame);
        } catch (error) {
          fail(frame.path, error);
        }
      }
    }
  }

  // Enumeration and removal are separate so a directory read never occupies
  // a deletion slot: the identity mapper prefetches up to 100 entries, the
  // deletion mapper independently buffers up to 100 results.
  const prefetched = new IterableMapper(source(), (entry) => entry, PREFETCH_OPTIONS);
  const completed = new IterableMapper(
    prefetched,
    async (entry) => {
      try {
        if (failed) return null;
        await removeEntry(
          entry.path,
          entry.directory,
          entry.parent?.path ?? null
        );
        return entry;
      } catch (error) {
        fail(entry.path, error);
        return null;
      } finally {
        const parent = entry.parent;
        if (parent !== undefined) {
          parent.pending -= 1;
          if (parent.pending === 0) parent.ready?.();
        }
      }
    },
    MAPPER_OPTIONS
  );

  let lastEmitAt = 0;
  let lastPath = root;
  for await (const entry of completed) {
    if (entry === null) continue;
    itemsDeleted += 1;
    lastPath = entry.path;
    const now = Date.now();
    if (now - lastEmitAt < PROGRESS_MS) continue;
    lastEmitAt = now;
    onProgress?.({ itemsDeleted, path: entry.path });
  }
  if (failure !== null) {
    const stopped: DeleteTreeError = failure;
    throw new DeleteTreeError(root, stopped.path, stopped.cause, itemsDeleted);
  }
  if (itemsDeleted > 0) onProgress?.({ itemsDeleted, path: lastPath });

  try {
    await FSP.lstat(root);
  } catch (error) {
    if (isMissing(error)) return;
    throw new DeleteTreeError(root, root, error, itemsDeleted);
  }
  throw new DeleteTreeError(
    root,
    root,
    new Error("it is still on disk after every entry was removed"),
    itemsDeleted
  );
}
