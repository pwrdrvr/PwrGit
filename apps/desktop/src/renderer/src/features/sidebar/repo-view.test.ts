import { describe, expect, it } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import {
  filterReposByLens,
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
    pinned: false,
    isPrimary: false,
    ...partial
  };
}

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
    expect(counts).toEqual({ Recent: 0, Pinned: 2, Behind: 1, All: 3 });
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
