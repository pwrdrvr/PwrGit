import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { ok, type FileSearchHit, type Result } from "@pwrgit/shared";

export const FILE_SEARCH_LIMIT_DEFAULT = 8;
export const FILE_SEARCH_LIMIT_MAX = 50;
/** The tracked-file list is re-read at most this often per worktree. A palette
 *  session queries on every keystroke, and `git ls-files` is an index read —
 *  cheap, but not free on a repository with six figures of files. */
export const FILE_LIST_TTL_MS = 5_000;
/** Worktrees whose list is kept. Bounded so a long session over many repos
 *  doesn't hold every file list it ever read. */
const FILE_LIST_CACHE_MAX = 3;

/**
 * A worktree's tracked paths, in the shape ranking actually reads.
 *
 * Parallel arrays rather than one object per path: `name` and `dir` are needed
 * only for the at-most-`limit` rows that get returned, so materialising them
 * for every path — and holding them for the session, since the TTL forces a
 * re-read but never evicts — cost roughly four times the string data of the
 * path list on a large monorepo. The basename offset is an integer, so scoring
 * reads the basename without allocating one.
 */
export type PathIndex = {
  paths: string[];
  lower: string[];
  /** Offset of the basename within each path: `lastIndexOf("/") + 1`. */
  nameStart: Int32Array;
};

export function indexFilePaths(paths: readonly string[]): PathIndex {
  const nameStart = new Int32Array(paths.length);
  const lower: string[] = new Array<string>(paths.length);
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i] ?? "";
    lower[i] = path.toLowerCase();
    nameStart[i] = path.lastIndexOf("/") + 1;
  }
  return { paths: [...paths], lower, nameStart };
}

function hit(index: PathIndex, i: number): FileSearchHit {
  const path = index.paths[i] ?? "";
  const start = index.nameStart[i] ?? 0;
  return {
    path,
    name: path.slice(start),
    dir: start === 0 ? "" : path.slice(0, start - 1)
  };
}

/**
 * Rank indexed paths against one query.
 *
 * Ordered so the thing a person types is the thing they get: a bare filename
 * finds the file, a fragment of a directory finds everything under it, and a
 * path pasted from a shell prompt matches end-first. Ties break on the shorter
 * path, which puts `src/App.tsx` above `src/legacy/vendor/App.tsx`.
 *
 * Matching is substring-only, deliberately. Subsequence ("fuzzy") matching
 * would let a three-letter query hit most of the repository, and these rows
 * sit ABOVE commits in the palette — a tier that loose would bury every other
 * kind of result behind noise.
 */
export function rankIndexedPaths(
  index: PathIndex,
  query: string,
  limit: number
): FileSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const scored: { at: number; score: number }[] = [];
  for (let at = 0; at < index.lower.length; at += 1) {
    const lower = index.lower[at] ?? "";
    const start = index.nameStart[at] ?? 0;
    const nameLength = lower.length - start;
    const score =
      nameLength === needle.length && lower.startsWith(needle, start)
        ? 0
        : lower.startsWith(needle, start)
          ? 1
          : lower.endsWith(needle)
            ? 2
            : lower.indexOf(needle, start) !== -1
              ? 3
              : lower.includes(needle)
                ? 4
                : null;
    if (score === null) continue;
    scored.push({ at, score });
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const left = index.paths[a.at] ?? "";
      const right = index.paths[b.at] ?? "";
      return (
        left.length - right.length ||
        (left < right ? -1 : left > right ? 1 : 0)
      );
    })
    .slice(0, limit)
    .map(({ at }) => hit(index, at));
}

type CachedList = { index: PathIndex; readAt: number };

/** One `git ls-files` read. A plain function, not a method: the cache object's
 *  own callers may destructure it, and `this` would not survive that. */
async function readTrackedPaths(
  git: GitExec,
  cwd: string,
  signal?: AbortSignal
): Promise<Result<PathIndex>> {
  const args = ["-c", "core.quotePath=false", "ls-files", "-z", "--cached"];
  const raw = await git(args, cwd, {
    ...NO_OPTIONAL_LOCKS,
    ...(signal === undefined ? {} : { signal })
  });
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  return ok(
    indexFilePaths(checked.value.stdout.split("\0").filter((path) => path !== ""))
  );
}

/** Tracked-path indexes, keyed by worktree, re-read on a short timer. */
export function createFileListCache(now: () => number = Date.now) {
  const lists = new Map<string, CachedList>();
  // Reads in flight, so concurrent queries for one worktree share a single
  // `git ls-files` instead of spawning one apiece. The palette debounces, but
  // the debounce lives in the renderer and this process owns process lifetime.
  const inFlight = new Map<string, Promise<Result<PathIndex>>>();

  return {
    async index(
      git: GitExec,
      worktreeId: string,
      cwd: string,
      signal?: AbortSignal
    ): Promise<Result<PathIndex>> {
      const cached = lists.get(worktreeId);
      if (cached !== undefined && now() - cached.readAt < FILE_LIST_TTL_MS) {
        return ok(cached.index);
      }
      const running = inFlight.get(worktreeId);
      if (running !== undefined) return running;

      const read = readTrackedPaths(git, cwd, signal);
      inFlight.set(worktreeId, read);
      try {
        const result = await read;
        if (!result.ok) return result;
        // Insertion order is the eviction order; re-reading a worktree moves it
        // back to the end so the three most recently used lists are the ones
        // kept.
        lists.delete(worktreeId);
        lists.set(worktreeId, { index: result.value, readAt: now() });
        while (lists.size > FILE_LIST_CACHE_MAX) {
          const oldest = lists.keys().next();
          if (oldest.done === true) break;
          lists.delete(oldest.value);
        }
        return result;
      } finally {
        inFlight.delete(worktreeId);
      }
    },
    forget(worktreeId: string): void {
      lists.delete(worktreeId);
    },
    size(): number {
      return lists.size;
    }
  };
}
