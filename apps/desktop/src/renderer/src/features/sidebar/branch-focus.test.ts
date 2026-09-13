import { describe, expect, it } from "vitest";
import type { LocalBranchSummary, Worktree } from "@pwrgit/shared";
import {
  branchActivation,
  branchFocusState,
  branchRelevance,
  branchSectionSummary,
  holderWorktreeId,
  isBranchSentinel,
  visibleBranches
} from "./branch-focus";

function branch(
  name: string,
  checkedOutWorktreeIds: string[] = [],
  tracking: LocalBranchSummary["tracking"] = "up_to_date"
): LocalBranchSummary {
  return {
    name,
    fullName: `refs/heads/${name}`,
    head: "0".repeat(40),
    ahead: 0,
    behind: 0,
    tracking,
    checkedOutWorktreeIds
  };
}

/** A branch git would print as `[origin/x: gone]` — its upstream was deleted. */
function goneBranch(name: string): LocalBranchSummary {
  return branch(name, [], "upstream_missing");
}

function worktree(id: string, b: string, path = `/repos/${id}`): Worktree {
  return {
    id,
    repoId: "repo-1",
    branch: b,
    path,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: b === "main",
    pinned: false,
    isPrimary: id === "wt-primary"
  };
}

describe("branchFocusState", () => {
  const focused = worktree("wt-primary", "main");

  it("marks the working target's own branch current", () => {
    expect(branchFocusState(branch("main", ["wt-primary"]), focused)).toBe(
      "current"
    );
  });

  it("marks a branch held by another worktree occupied", () => {
    expect(branchFocusState(branch("feature/x", ["wt-2"]), focused)).toBe(
      "occupied"
    );
  });

  it("marks a branch with no worktree free", () => {
    expect(branchFocusState(branch("feature/y"), focused)).toBe("free");
  });

  // The marker is unique across the WINDOW: a repo that does not own the
  // working target has no current branch, only occupied ones. Otherwise a
  // dozen expanded repos would each claim a current row.
  it("has no current branch when the working target is elsewhere", () => {
    expect(branchFocusState(branch("main", ["wt-primary"]), null)).toBe(
      "occupied"
    );
    expect(branchFocusState(branch("feature/y"), null)).toBe("free");
  });
});

describe("branchActivation", () => {
  const focused = worktree("wt-primary", "main");

  it("does nothing for the branch already checked out here", () => {
    expect(branchActivation(branch("main", ["wt-primary"]), focused)).toEqual({
      kind: "none"
    });
  });

  // The cheapest safe route: git refuses a second checkout of one branch, and
  // that refusal teaches the user nothing — going to the worktree does.
  it("reveals the holding worktree instead of attempting a checkout", () => {
    expect(branchActivation(branch("feature/x", ["wt-2"]), focused)).toEqual({
      kind: "reveal",
      worktreeId: "wt-2"
    });
  });

  it("switches for a free branch", () => {
    expect(branchActivation(branch("feature/y"), focused)).toEqual({
      kind: "switch",
      branch: "feature/y"
    });
  });

  // A stale refs snapshot can list the focused worktree as holding a branch it
  // no longer has. Revealing it is harmless and forces a refresh; attempting a
  // switch git would refuse is not.
  it("prefers a holder that is not the working target", () => {
    expect(
      branchActivation(branch("feature/x", ["wt-primary", "wt-2"]), focused)
    ).toEqual({ kind: "reveal", worktreeId: "wt-2" });
  });
});

describe("holderWorktreeId", () => {
  it("is null when nothing holds the branch", () => {
    expect(holderWorktreeId(branch("feature/y"), "wt-primary")).toBeNull();
  });

  it("falls back to the only holder even when it is the working target", () => {
    expect(holderWorktreeId(branch("main", ["wt-primary"]), "wt-primary")).toBe(
      "wt-primary"
    );
  });
});

describe("branchSectionSummary", () => {
  it("names the branch the working target sits on", () => {
    expect(branchSectionSummary(worktree("wt-primary", "main"))).toBe("on main");
  });

  it("is null when no worktree here is the working target", () => {
    expect(branchSectionSummary(null)).toBeNull();
  });

  // `Worktree.branch` is not always a branch name — listWorktrees substitutes
  // three sentinels when git reports no branch line, and none of them may be
  // printed as though it were one.
  it("reports a detached checkout as detached", () => {
    expect(branchSectionSummary(worktree("wt-2", "detached@0123456"))).toBe(
      "detached"
    );
  });

  it("says nothing for the bare and unknown sentinels", () => {
    expect(branchSectionSummary(worktree("wt-2", "(bare)"))).toBeNull();
    expect(branchSectionSummary(worktree("wt-2", "(unknown)"))).toBeNull();
  });
});

describe("isBranchSentinel", () => {
  it("covers all three synthetic labels", () => {
    expect(isBranchSentinel("detached@abc1234")).toBe(true);
    expect(isBranchSentinel("(bare)")).toBe(true);
    expect(isBranchSentinel("(unknown)")).toBe(true);
    expect(isBranchSentinel("main")).toBe(false);
    // A real branch may legitimately start with "detached" — only the
    // "detached@" prefix git itself produces counts.
    expect(isBranchSentinel("detached-head-fix")).toBe(false);
  });
});

describe("branchRelevance", () => {
  it("ranks the working target's branch above everything", () => {
    const b = branch("main", ["wt-primary"]);
    expect(branchRelevance(b, worktree("wt-primary", "main"))).toBe(1);
  });

  it("ranks a branch some other worktree holds second", () => {
    const b = branch("feature", ["wt-2"]);
    expect(branchRelevance(b, worktree("wt-primary", "main"))).toBe(2);
  });

  // Occupancy is a per-repo fact that does not depend on where the window's
  // working target is: a worktree of THIS repo is sitting on it either way.
  it("still ranks a held branch second with no working target here", () => {
    expect(branchRelevance(branch("feature", ["wt-2"]), null)).toBe(2);
  });

  it("drops a branch whose upstream was deleted to the bottom", () => {
    expect(branchRelevance(goneBranch("merged"), null)).toBe(4);
  });

  // A gone branch someone is standing in is still where they are standing.
  it("keeps a held branch ahead of gone even when its upstream is gone", () => {
    const held = branch("merged", ["wt-2"], "upstream_missing");
    expect(branchRelevance(held, null)).toBe(2);
  });

  it("ranks everything else alike, so committer date still decides", () => {
    expect(branchRelevance(branch("a"), null)).toBe(3);
    expect(branchRelevance(branch("b", [], "unpublished"), null)).toBe(3);
    expect(branchRelevance(branch("c", [], "diverged"), null)).toBe(3);
  });
});

describe("visibleBranches", () => {
  const all = [
    branch("a"),
    branch("b"),
    branch("c"),
    branch("d"),
    branch("e"),
    branch("f"),
    branch("target", ["wt-primary"])
  ];

  // Without the pin the pairing is invisible for any branch that does not sort
  // into the slice — which is most of them in a repo with 161 branches.
  it("pins the working target's branch first", () => {
    const shown = visibleBranches(all, worktree("wt-primary", "target"), 6);
    expect(shown.map((b) => b.name)).toEqual(["target", "a", "b", "c", "d", "e"]);
  });

  it("does not duplicate a current branch already in the slice", () => {
    const shown = visibleBranches(all, worktree("wt-primary", "b"), 6);
    // `target` follows because a worktree holds it — the fixture's snapshot is
    // stale (wt-primary reports `b`), which is exactly the case
    // `holderWorktreeId` exists for, and occupancy still outranks a free row.
    expect(shown.map((b) => b.name)).toEqual(["b", "target", "a", "c", "d", "e"]);
  });

  // `target` is held by wt-primary, which is a per-repo fact — so it outranks
  // the free branches whether or not this repo owns the window's selection.
  it("still lifts a held branch when nothing here is focused", () => {
    expect(visibleBranches(all, null, 3).map((b) => b.name)).toEqual([
      "target",
      "a",
      "b"
    ]);
  });

  it("ignores a focused branch the repo does not list", () => {
    const shown = visibleBranches(all, worktree("wt-primary", "gone"), 2);
    expect(shown.map((b) => b.name)).toEqual(["target", "a"]);
  });

  // The reported case: a repo whose local branches are mostly finished work.
  // Tip date alone fills the whole slice with corpses.
  it("spends the slice on live branches before gone ones", () => {
    const repo = [
      goneBranch("fix/linux-window-show"),
      goneBranch("feat/editor-blur-styles"),
      branch("main", ["wt-primary"]),
      branch("feat/in-progress")
    ];
    expect(
      visibleBranches(repo, worktree("wt-primary", "main"), 3).map((b) => b.name)
    ).toEqual(["main", "feat/in-progress", "fix/linux-window-show"]);
  });

  // Only the tier is a sort key. Inside one, the caller's committer-date order
  // has to survive, or the slice would reshuffle branches it has no opinion on.
  it("keeps arrival order within a tier", () => {
    const repo = [branch("newest"), branch("middle"), branch("oldest")];
    expect(visibleBranches(repo, null, 3).map((b) => b.name)).toEqual([
      "newest",
      "middle",
      "oldest"
    ]);
  });

  it("does not mutate the list it was given", () => {
    const repo = [goneBranch("gone"), branch("live")];
    visibleBranches(repo, null, 2);
    expect(repo.map((b) => b.name)).toEqual(["gone", "live"]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(visibleBranches(all, worktree("wt-primary", "target"), 0)).toEqual([]);
  });
});
