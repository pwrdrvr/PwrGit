import type { Lens, Repo, Worktree, WorktreeSort } from "@pwrgit/shared";

export const LENSES: Lens[] = ["Recent", "Pinned", "Behind", "Stale", "All"];

/**
 * The folder-row "behind" count reflects the repo's **primary checkout** (its
 * local directory), not a max across all worktrees — a stale feature-branch
 * worktree that's behind its own upstream shouldn't make the whole repo look
 * behind. Falls back to the first worktree if none is flagged primary.
 */
export function repoPrimaryBehind(repo: Repo): number {
  const primary = repo.worktrees.find((w) => w.isPrimary) ?? repo.worktrees[0];
  return primary?.behind ?? 0;
}

export type RepoGroup = { root: string; label: string; repos: Repo[] };

// Repo/root paths arrive with the platform's separators (backslashes on
// Windows); normalize before any prefix or segment math so grouping doesn't
// silently dump every repo into "Other" off-POSIX.
const normalizeSlashes = (path: string): string => path.replace(/\\/g, "/");

// Windows paths (drive-letter prefix) additionally compare case-insensitively:
// repo paths come from `git worktree list`, which reports true-case
// forward-slash paths (C:/Users/runneradmin/…), while picked roots keep the
// shell's casing (C:\Users\RUNNERADMIN\…) — same directory, different string.
const comparablePath = (path: string): string => {
  const normalized = normalizeSlashes(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

const lastSegment = (path: string): string =>
  normalizeSlashes(path).split("/").filter(Boolean).pop() ?? path;

const isUnder = (path: string, root: string): boolean => {
  const p = comparablePath(path);
  const r = comparablePath(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
};

/**
 * Bucket repos by the scan root they live under (longest-prefix wins, so nested
 * roots attribute correctly). Empty groups are dropped; repos under no root land
 * in a trailing "Other" group. Order follows the profile's root order.
 */
export function groupReposByRoot(repos: Repo[], roots: string[]): RepoGroup[] {
  const byLongest = [...roots].sort((a, b) => b.length - a.length);
  const buckets = new Map<string, Repo[]>(roots.map((r) => [r, []]));
  const other: Repo[] = [];
  for (const repo of repos) {
    const root = byLongest.find((r) => isUnder(repo.path, r));
    if (root === undefined) other.push(repo);
    else buckets.get(root)?.push(repo);
  }
  const groups: RepoGroup[] = roots
    .map((r) => ({ root: r, label: lastSegment(r), repos: buckets.get(r) ?? [] }))
    .filter((g) => g.repos.length > 0);
  if (other.length > 0) groups.push({ root: "", label: "Other", repos: other });
  return groups;
}

/** A worktree is "safe to prune": clean, fully merged into the default branch,
 *  not the default/primary checkout, and untouched for a while. */
export const STALE_AGE_DAYS = 14;

export function isPrunableWorktree(w: Worktree, now: number = Date.now()): boolean {
  if (w.isDefaultBranch || w.isPrimary) return false;
  if (w.dirty > 0) return false;
  // A merged PR is definitive — the work is in the base branch, so it's safe to
  // prune at any age. This catches squash/rebase merges that the git-ancestry
  // check below can't see (the original commits aren't in the default branch).
  if (w.pr?.state === "merged") return true;
  // Otherwise fall back to the git heuristic: contained in the default branch,
  // or sharing no history with it (rewritten/orphaned) — both plus old + clean.
  if (!w.mergedIntoDefault && !w.divergedFromDefault) return false;
  if (w.lastActivityAt === undefined) return false;
  const ageMs = now - new Date(w.lastActivityAt).getTime();
  return ageMs > STALE_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function repoIsPinned(r: Repo): boolean {
  return r.pinned || r.worktrees.some((w) => w.pinned);
}

function repoHasPrunable(r: Repo, now: number): boolean {
  return r.worktrees.some((w) => isPrunableWorktree(w, now));
}

/** Counts shown on the lens chips. Recent has no counter (it's the default). */
export function lensCounts(
  repos: Repo[],
  now: number = Date.now()
): Record<Lens, number> {
  return {
    Recent: 0,
    Pinned: repos.filter(repoIsPinned).length,
    Behind: repos.filter((r) => r.worktrees.some((w) => w.behind > 0)).length,
    Stale: repos.filter((r) => repoHasPrunable(r, now)).length,
    All: repos.length
  };
}

/**
 * Compact a lens count so the filter row stays inside the sidebar. Five chips
 * share one row, and a four-digit count is wide enough to push the row past
 * what it has — the tracks are floored at their content width, so an
 * unabbreviated "1099" would overflow the pill rather than clip inside it.
 *
 * Truncates rather than rounds: a count is a floor ("at least this many"), so
 * 1999 reads 1.9K, never 2K. One decimal only below 10 of a unit — past that
 * the decimal costs a glyph without telling you anything you'd act on.
 *
 *   999 → "999"    1000 → "1K"     1150 → "1.1K"
 *   1999 → "1.9K"  10_400 → "10K"  1_250_000 → "1.2M"
 */
export function formatLensCount(count: number): string {
  if (!Number.isFinite(count) || count < 1000) return String(count);
  const [value, suffix] =
    count < 1_000_000 ? [count / 1000, "K"] : [count / 1_000_000, "M"];
  // Truncate to one decimal, then drop a trailing ".0" so 1000 reads "1K".
  const truncated = Math.floor(value * 10) / 10;
  const shown = truncated < 10 ? truncated.toFixed(1).replace(/\.0$/, "") : String(Math.floor(truncated));
  return `${shown}${suffix}`;
}

/** Filter by lens, then float pinned repos to the top (stable otherwise). */
export function filterReposByLens(
  repos: Repo[],
  lens: Lens,
  now: number = Date.now()
): Repo[] {
  let list = repos;
  if (lens === "Behind") {
    list = repos.filter((r) => r.worktrees.some((w) => w.behind > 0));
  } else if (lens === "Pinned") {
    list = repos.filter(repoIsPinned);
  } else if (lens === "Stale") {
    list = repos.filter((r) => repoHasPrunable(r, now));
  }
  return [...list].sort(
    (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
  );
}

export const SORT_CYCLE: Record<Exclude<WorktreeSort, "custom">, WorktreeSort> = {
  recent: "pinned",
  pinned: "az",
  az: "active",
  active: "recent"
};

export const SORT_LABEL: Record<WorktreeSort, string> = {
  recent: "Recent",
  pinned: "Pinned",
  az: "A–Z",
  active: "Active",
  custom: "Custom"
};

/**
 * Order a worktree list. A user drag-order (customOrder) wins; otherwise the
 * selected sort mode applies.
 */
export function orderWorktrees(
  worktrees: Worktree[],
  sort: WorktreeSort,
  customOrder?: string[]
): Worktree[] {
  const list = [...worktrees];
  if (customOrder !== undefined && customOrder.length > 0) {
    const rank = (id: string): number => {
      const i = customOrder.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return list.sort((a, b) => rank(a.id) - rank(b.id));
  }
  if (sort === "recent") {
    // Most recently active first, so live work floats to the top instead of
    // whatever discovery order happened to produce. Rows without a computed
    // timestamp (state not filled yet) sink to the bottom and shuffle into
    // place as their state lands.
    return list.sort((a, b) => {
      const ta =
        a.lastActivityAt !== undefined ? Date.parse(a.lastActivityAt) : -1;
      const tb =
        b.lastActivityAt !== undefined ? Date.parse(b.lastActivityAt) : -1;
      return tb - ta;
    });
  }
  if (sort === "az") {
    // Case-insensitive + natural-numeric, so "Foo" sits by "foo" and "v2"
    // precedes "v10" — not ASCII order with every capital hoisted to the top.
    return list.sort((a, b) =>
      a.branch.localeCompare(b.branch, undefined, {
        sensitivity: "accent",
        numeric: true
      })
    );
  }
  if (sort === "active") {
    return list.sort((a, b) => b.dirty + b.ahead - (a.dirty + a.ahead));
  }
  // "pinned"
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/**
 * Keep the primary checkout and pinned linked worktrees in the always-visible
 * part of an expanded repo. The remaining linked worktrees retain the user's
 * chosen ordering behind the Worktrees disclosure.
 */
export function groupWorktreesForNavigation(
  worktrees: Worktree[],
  sort: WorktreeSort,
  customOrder?: string[]
): {
  primary: Worktree | undefined;
  pinned: Worktree[];
  remaining: Worktree[];
  displayIds: string[];
} {
  const primary = worktrees.find((worktree) => worktree.isPrimary);
  const ordered = orderWorktrees(
    worktrees.filter((worktree) => !worktree.isPrimary),
    sort,
    customOrder
  );
  const pinned = ordered.filter((worktree) => worktree.pinned);
  const remaining = ordered.filter((worktree) => !worktree.pinned);
  return {
    primary,
    pinned,
    remaining,
    displayIds: [
      ...(primary === undefined ? [] : [primary.id]),
      ...pinned.map((worktree) => worktree.id),
      ...remaining.map((worktree) => worktree.id)
    ]
  };
}

/** Short relative age label for a last-activity timestamp. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Move an id to sit just before `beforeId` (drag-reorder). */
export function reorder(
  ids: string[],
  dragId: string,
  beforeId: string
): string[] {
  if (dragId === beforeId) return ids;
  const next = ids.filter((id) => id !== dragId);
  const at = next.indexOf(beforeId);
  if (at === -1) return ids;
  next.splice(at, 0, dragId);
  return next;
}
