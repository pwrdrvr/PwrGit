import { describe, expect, it } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import {
  filterReposByLens,
  groupReposByRoot,
  isPrunableWorktree,
  lensCounts,
  orderWorktrees,
  reorder,
  repoPrimaryBehind,
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
    divergedFromDefault: false,
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

  it("sort cycle is recent → pinned → az → active → recent", () => {
    expect(SORT_CYCLE.recent).toBe("pinned");
    expect(SORT_CYCLE.pinned).toBe("az");
    expect(SORT_CYCLE.az).toBe("active");
    expect(SORT_CYCLE.active).toBe("recent");
  });

  it("Recent sorts by last activity, missing timestamps last", () => {
    const dated = [
      wt({ id: "old", branch: "old", lastActivityAt: "2026-06-01T00:00:00Z" }),
      wt({ id: "none", branch: "none" }),
      wt({ id: "new", branch: "new", lastActivityAt: "2026-07-10T00:00:00Z" })
    ];
    expect(orderWorktrees(dated, "recent").map((w) => w.id)).toEqual([
      "new",
      "old",
      "none"
    ]);
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

  it("also flags a clean, diverged (orphaned), old worktree as prunable", () => {
    const diverged = wt({
      id: "d",
      branch: "orphan",
      mergedIntoDefault: false,
      divergedFromDefault: true,
      lastActivityAt: OLD
    });
    expect(isPrunableWorktree(diverged)).toBe(true);
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

describe("groupReposByRoot", () => {
  const repos: Repo[] = [
    repo({ id: "acme-svc", path: "/Users/h/Acme/acme-svc" }),
    repo({ id: "pwrgit", path: "/Users/h/pwrdrvr/PwrGit" }),
    repo({ id: "kit", path: "/Users/h/github/agent-kit" }),
    repo({ id: "loose", path: "/Users/h/elsewhere/loose" })
  ];
  const roots = ["/Users/h/pwrdrvr", "/Users/h/github", "/Users/h/Acme"];

  it("buckets repos under their root, labelled by the folder's last segment", () => {
    const groups = groupReposByRoot(repos, roots);
    expect(groups.map((g) => [g.label, g.repos.map((r) => r.id)])).toEqual([
      ["pwrdrvr", ["pwrgit"]],
      ["github", ["kit"]],
      ["Acme", ["acme-svc"]],
      ["Other", ["loose"]]
    ]);
  });

  it("attributes to the longest matching root when roots nest", () => {
    const nested = ["/Users/h", "/Users/h/pwrdrvr"];
    const groups = groupReposByRoot(
      [repo({ id: "pwrgit", path: "/Users/h/pwrdrvr/PwrGit" })],
      nested
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.root).toBe("/Users/h/pwrdrvr");
  });

  it("drops empty groups and omits Other when all repos are placed", () => {
    const groups = groupReposByRoot([repos[0]!], roots);
    expect(groups.map((g) => g.label)).toEqual(["Acme"]);
  });
});

describe("repoPrimaryBehind", () => {
  it("reflects the primary checkout, not the max across worktrees", () => {
    const r = repo({
      id: "svc",
      worktrees: [
        wt({ id: "p", branch: "develop", isPrimary: true, behind: 0 }),
        wt({ id: "f", branch: "feature", behind: 5 })
      ]
    });
    expect(repoPrimaryBehind(r)).toBe(0);
  });

  it("reports the primary's own behind count", () => {
    const r = repo({
      id: "svc",
      worktrees: [
        wt({ id: "p", branch: "develop", isPrimary: true, behind: 3 }),
        wt({ id: "f", branch: "feature", behind: 5 })
      ]
    });
    expect(repoPrimaryBehind(r)).toBe(3);
  });

  it("falls back to the first worktree when none is flagged primary", () => {
    const r = repo({ id: "svc", worktrees: [wt({ id: "a", branch: "x", behind: 2 })] });
    expect(repoPrimaryBehind(r)).toBe(2);
  });
});

describe("staleness with PR status", () => {
  const recently = new Date().toISOString();
  const mergedPr = { number: 5, url: "u", title: "t", state: "merged" as const, isDraft: false };

  it("prunes a merged-PR worktree at any age (catches squash/rebase merges)", () => {
    const w = wt({
      id: "m",
      branch: "feat/squashed",
      mergedIntoDefault: false,
      divergedFromDefault: false,
      lastActivityAt: recently,
      pr: mergedPr
    });
    expect(isPrunableWorktree(w)).toBe(true);
  });

  it("does not prune on an open PR, and not while dirty even if merged", () => {
    const open = wt({
      id: "o",
      branch: "feat/open",
      lastActivityAt: recently,
      pr: { number: 1, url: "u", title: "t", state: "open", isDraft: false }
    });
    expect(isPrunableWorktree(open)).toBe(false);
    expect(isPrunableWorktree({ ...open, dirty: 1, pr: mergedPr })).toBe(false);
  });
});
