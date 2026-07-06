import type { Lens, Repo, Worktree, WorktreeSort } from "@pwrgit/shared";

export const LENSES: Lens[] = ["Recent", "Pinned", "Behind", "All"];

function repoIsPinned(r: Repo): boolean {
  return r.pinned || r.worktrees.some((w) => w.pinned);
}

/** Counts shown on the lens chips. Recent has no counter (it's the default). */
export function lensCounts(repos: Repo[]): Record<Lens, number> {
  return {
    Recent: 0,
    Pinned: repos.filter(repoIsPinned).length,
    Behind: repos.filter((r) => r.worktrees.some((w) => w.behind > 0)).length,
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
