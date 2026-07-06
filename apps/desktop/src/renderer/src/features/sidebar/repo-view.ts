import type { Lens, Repo, Worktree, WorktreeSort } from "@pwrgit/shared";

export const LENSES: Lens[] = ["Recent", "Pinned", "Behind", "Stale", "All"];

export type RepoGroup = { root: string; label: string; repos: Repo[] };

const lastSegment = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? path;

const isUnder = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

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
  // Safe to prune when merged into the default branch, or when the branch
  // shares no history with it (rewritten/orphaned) — both plus old + clean.
  if (!w.mergedIntoDefault && !w.divergedFromDefault) return false;
  if (w.lastActivityAt === undefined) return false;
  const ageMs = now - new Date(w.lastActivityAt).getTime();
  return ageMs > STALE_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function repoIsPinned(r: Repo): boolean {
  return r.pinned || r.worktrees.some((w) => w.pinned);
}

function repoHasPrunable(r: Repo): boolean {
  return r.worktrees.some((w) => isPrunableWorktree(w));
}

/** Counts shown on the lens chips. Recent has no counter (it's the default). */
export function lensCounts(repos: Repo[]): Record<Lens, number> {
  return {
    Recent: 0,
    Pinned: repos.filter(repoIsPinned).length,
    Behind: repos.filter((r) => r.worktrees.some((w) => w.behind > 0)).length,
    Stale: repos.filter(repoHasPrunable).length,
    All: repos.length
  };
}

/** Filter by lens, then float pinned repos to the top (stable otherwise). */
export function filterReposByLens(repos: Repo[], lens: Lens): Repo[] {
  let list = repos;
  if (lens === "Behind") {
    list = repos.filter((r) => r.worktrees.some((w) => w.behind > 0));
  } else if (lens === "Pinned") {
    list = repos.filter(repoIsPinned);
  } else if (lens === "Stale") {
    list = repos.filter(repoHasPrunable);
  }
  return [...list].sort(
    (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
  );
}

export const SORT_CYCLE: Record<Exclude<WorktreeSort, "custom">, WorktreeSort> = {
  pinned: "az",
  az: "active",
  active: "pinned"
};

export const SORT_LABEL: Record<WorktreeSort, string> = {
  pinned: "Pinned",
  az: "A–Z",
  active: "Active",
  custom: "Custom"
};

/**
 * Order a repo's worktrees. A user drag-order (customOrder) wins; otherwise the
 * sort mode applies. The incoming list is primary-first (from the indexer), so
 * "pinned" keeps primary near the top while floating pinned worktrees up.
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
  if (sort === "az") {
    return list.sort((a, b) => a.branch.localeCompare(b.branch));
  }
  if (sort === "active") {
    return list.sort((a, b) => b.dirty + b.ahead - (a.dirty + a.ahead));
  }
  // "pinned"
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
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
