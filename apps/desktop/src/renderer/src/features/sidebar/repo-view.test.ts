import { describe, expect, it } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import {
  filterReposByLens,
  isPrunableWorktree,
  lensCounts,
  orderWorktrees,
  reorder,
  SORT_CYCLE
} from "./repo-view";

function wt(partial: Partial<Worktree> & { id: string; branch: string }): Worktree {
  return {
    repoId: "r",
    path: `/${partial.id}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    mergedIntoDefault: false,
    isDefaultBranch: false,
    pinned: false,
    isPrimary: false,
    ...partial
  };
}

const OLD = "2000-01-01T00:00:00.000Z";

function repo(partial: Partial<Repo> & { id: string }): Repo {
  return {
    name: partial.id,
    path: `/${partial.id}`,
    profileId: "p",
    pinned: false,
    worktrees: [],
    ...partial
  };
}

describe("lensCounts / filterReposByLens", () => {
  const repos: Repo[] = [
    repo({ id: "a", pinned: true }),
    repo({ id: "b", worktrees: [wt({ id: "b1", branch: "main", behind: 2 })] }),
    repo({ id: "c", worktrees: [wt({ id: "c1", branch: "main", pinned: true })] })
  ];

  it("counts pinned (repo or worktree), behind, and all", () => {
    const counts = lensCounts(repos);
    expect(counts).toEqual({ Recent: 0, Pinned: 2, Behind: 1, Stale: 0, All: 3 });
  });

  it("Behind lens keeps only repos with a behind worktree", () => {
    expect(filterReposByLens(repos, "Behind").map((r) => r.id)).toEqual(["b"]);
  });

  it("Pinned lens keeps repo- or worktree-pinned repos", () => {
    expect(filterReposByLens(repos, "Pinned").map((r) => r.id).sort()).toEqual([
      "a",
      "c"
    ]);
  });

  it("All lens floats pinned repos to the top", () => {
    expect(filterReposByLens(repos, "All")[0]?.id).toBe("a");
  });
});

describe("orderWorktrees", () => {
  const worktrees = [
    wt({ id: "1", branch: "main", isPrimary: true }),
    wt({ id: "2", branch: "zeta", dirty: 5 }),
    wt({ id: "3", branch: "alpha", pinned: true })
  ];

  it("sort cycle is pinned → az → active → pinned", () => {
    expect(SORT_CYCLE.pinned).toBe("az");
    expect(SORT_CYCLE.az).toBe("active");
    expect(SORT_CYCLE.active).toBe("pinned");
  });

  it("A–Z sorts by branch name", () => {
    expect(orderWorktrees(worktrees, "az").map((w) => w.branch)).toEqual([
      "alpha",
      "main",
      "zeta"
    ]);
  });

  it("Active sorts by dirty+ahead descending", () => {
    expect(orderWorktrees(worktrees, "active")[0]?.branch).toBe("zeta");
  });

  it("pinned floats pinned worktrees up", () => {
    expect(orderWorktrees(worktrees, "pinned")[0]?.branch).toBe("alpha");
  });

  it("custom order overrides the sort mode", () => {
    const ordered = orderWorktrees(worktrees, "az", ["2", "3", "1"]);
    expect(ordered.map((w) => w.id)).toEqual(["2", "3", "1"]);
  });
});

describe("reorder", () => {
  it("moves the dragged id in front of the target", () => {
    expect(reorder(["1", "2", "3"], "3", "1")).toEqual(["3", "1", "2"]);
  });
  it("is a no-op when dragging onto itself", () => {
    expect(reorder(["1", "2", "3"], "2", "2")).toEqual(["1", "2", "3"]);
  });
});

describe("staleness (isPrunableWorktree + Stale lens)", () => {
  const prunable = wt({
    id: "p",
    branch: "old/merged",
    mergedIntoDefault: true,
    lastActivityAt: OLD
  });

  it("flags a clean, merged, old, non-default worktree as prunable", () => {
    expect(isPrunableWorktree(prunable)).toBe(true);
  });

  it("excludes dirty, unmerged, default, recent, or primary worktrees", () => {
    expect(isPrunableWorktree({ ...prunable, dirty: 2 })).toBe(false);
    expect(isPrunableWorktree({ ...prunable, mergedIntoDefault: false })).toBe(
      false
    );
    expect(isPrunableWorktree({ ...prunable, isDefaultBranch: true })).toBe(
      false
    );
    expect(isPrunableWorktree({ ...prunable, isPrimary: true })).toBe(false);
    expect(
      isPrunableWorktree({ ...prunable, lastActivityAt: new Date().toISOString() })
    ).toBe(false);
  });

  it("Stale lens filters to repos with a prunable worktree and counts them", () => {
    const repos = [
      repo({ id: "stale", worktrees: [prunable] }),
      repo({ id: "fresh", worktrees: [wt({ id: "f", branch: "main", isDefaultBranch: true })] })
    ];
    expect(lensCounts(repos).Stale).toBe(1);
    expect(filterReposByLens(repos, "Stale").map((r) => r.id)).toEqual(["stale"]);
  });
});
