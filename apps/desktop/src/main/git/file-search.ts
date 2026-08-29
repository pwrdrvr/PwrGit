import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { err, ok, type FileSearchHit, type Result } from "@pwrgit/shared";

export const FILE_SEARCH_LIMIT_DEFAULT = 8;
export const FILE_SEARCH_LIMIT_MAX = 50;
/** The tracked-file list is re-read at most this often per worktree. A palette
 *  session queries on every keystroke, and `git ls-files` is an index read —
 *  cheap, but not free on a repository with six figures of files. */
export const FILE_LIST_TTL_MS = 5_000;
/** Worktrees whose list is kept. Bounded so a long session over many repos
 *  doesn't hold every file list it ever read. */
const FILE_LIST_CACHE_MAX = 3;

const split = (path: string): { name: string; dir: string } => {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { name: path, dir: "" }
    : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
};

/**
 * Rank tracked paths against one query.
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
export function rankFilePaths(
  paths: readonly string[],
  query: string,
  limit: number
): FileSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const scored: { hit: FileSearchHit; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const { name, dir } = split(path);
    const lowerName = name.toLowerCase();
    const score =
      lowerName === needle
        ? 0
        : lowerName.startsWith(needle)
          ? 1
          : lower.endsWith(needle)
            ? 2
            : lowerName.includes(needle)
              ? 3
              : lower.includes(needle)
                ? 4
                : null;
    if (score === null) continue;
    scored.push({ hit: { path, name, dir }, score });
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.hit.path.length - b.hit.path.length ||
        (a.hit.path < b.hit.path ? -1 : a.hit.path > b.hit.path ? 1 : 0)
    )
    .slice(0, limit)
    .map(({ hit }) => hit);
}

type CachedList = { paths: string[]; readAt: number };

/** Tracked-path lists, keyed by worktree, re-read on a short timer. */
export function createFileListCache(now: () => number = Date.now) {
  const lists = new Map<string, CachedList>();

  return {
    async paths(
      git: GitExec,
      worktreeId: string,
      cwd: string,
      signal?: AbortSignal
    ): Promise<Result<string[]>> {
      const cached = lists.get(worktreeId);
      if (cached !== undefined && now() - cached.readAt < FILE_LIST_TTL_MS) {
        return ok(cached.paths);
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
      const paths = checked.value.stdout.split("\0").filter((p) => p !== "");
      // Insertion order is the eviction order; re-reading a worktree moves it
      // back to the end so the three most recently used lists are the ones
      // kept.
      lists.delete(worktreeId);
      lists.set(worktreeId, { paths, readAt: now() });
      while (lists.size > FILE_LIST_CACHE_MAX) {
        const oldest = lists.keys().next();
        if (oldest.done === true) break;
        lists.delete(oldest.value);
      }
      return ok(paths);
    },
    forget(worktreeId: string): void {
      lists.delete(worktreeId);
    },
    size(): number {
      return lists.size;
    }
  };
}

export function invalidQuery(query: unknown): Result<never> | null {
  return typeof query === "string"
    ? null
    : err({
        kind: "validation",
        code: "invalid_query",
        message: "A file-search query is required."
      });
}
