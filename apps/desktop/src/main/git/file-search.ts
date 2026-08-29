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
 * One tracked path with everything ranking needs precomputed.
 *
 * The lowercase forms live here rather than in the ranking loop because that
 * loop runs on every keystroke: folding a hundred thousand paths per character
 * typed allocated two strings per path and threw both away.
 */
export type IndexedPath = FileSearchHit & {
  lowerPath: string;
  lowerName: string;
};

export function indexFilePaths(paths: readonly string[]): IndexedPath[] {
  return paths.map((path) => {
    const cut = path.lastIndexOf("/");
    const name = cut === -1 ? path : path.slice(cut + 1);
    return {
      path,
      name,
      dir: cut === -1 ? "" : path.slice(0, cut),
      lowerPath: path.toLowerCase(),
      lowerName: name.toLowerCase()
    };
  });
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
  index: readonly IndexedPath[],
  query: string,
  limit: number
): FileSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const scored: { entry: IndexedPath; score: number }[] = [];
  for (const entry of index) {
    const score =
      entry.lowerName === needle
        ? 0
        : entry.lowerName.startsWith(needle)
          ? 1
          : entry.lowerPath.endsWith(needle)
            ? 2
            : entry.lowerName.includes(needle)
              ? 3
              : entry.lowerPath.includes(needle)
                ? 4
                : null;
    if (score === null) continue;
    scored.push({ entry, score });
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.path.length - b.entry.path.length ||
        (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0)
    )
    .slice(0, limit)
    .map(({ entry }) => ({ path: entry.path, name: entry.name, dir: entry.dir }));
}

type CachedList = { index: IndexedPath[]; readAt: number };

/** Tracked-path indexes, keyed by worktree, re-read on a short timer. */
export function createFileListCache(now: () => number = Date.now) {
  const lists = new Map<string, CachedList>();

  return {
    async index(
      git: GitExec,
      worktreeId: string,
      cwd: string,
      signal?: AbortSignal
    ): Promise<Result<IndexedPath[]>> {
      const cached = lists.get(worktreeId);
      if (cached !== undefined && now() - cached.readAt < FILE_LIST_TTL_MS) {
        return ok(cached.index);
      }
      const args = [
        "-c",
        "core.quotePath=false",
        "ls-files",
        "-z",
        "--cached"
      ];
      const raw = await git(args, cwd, {
        ...NO_OPTIONAL_LOCKS,
        ...(signal === undefined ? {} : { signal })
      });
      if (!raw.ok) return raw;
      const checked = requireExit0(raw.value, args);
      if (!checked.ok) return checked;
      const index = indexFilePaths(
        checked.value.stdout.split("\0").filter((path) => path !== "")
      );
      // Insertion order is the eviction order; re-reading a worktree moves it
      // back to the end so the three most recently used lists are the ones
      // kept.
      lists.delete(worktreeId);
      lists.set(worktreeId, { index, readAt: now() });
      while (lists.size > FILE_LIST_CACHE_MAX) {
        const oldest = lists.keys().next();
        if (oldest.done === true) break;
        lists.delete(oldest.value);
      }
      return ok(index);
    },
    forget(worktreeId: string): void {
      lists.delete(worktreeId);
    },
    size(): number {
      return lists.size;
    }
  };
}
