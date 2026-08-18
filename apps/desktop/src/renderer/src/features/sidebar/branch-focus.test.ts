import { describe, expect, it } from "vitest";
import type { LocalBranchSummary, Worktree } from "@pwrgit/shared";
import {
  branchActivation,
  branchFocusState,
  branchSectionSummary,
  holderWorktreeId,
  isBranchSentinel,
  visibleBranches
} from "./branch-focus";

function branch(
  name: string,
  checkedOutWorktreeIds: string[] = []
): LocalBranchSummary {
  return {
    name,
    fullName: `refs/heads/${name}`,
    head: "0".repeat(40),
    ahead: 0,
    behind: 0,
    tracking: "up_to_date",
    checkedOutWorktreeIds
  };
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
    expect(shown.map((b) => b.name)).toEqual(["b", "a", "c", "d", "e", "f"]);
  });

  it("keeps the plain head of the list when nothing here is focused", () => {
    expect(visibleBranches(all, null, 3).map((b) => b.name)).toEqual([
      "a",
      "b",
      "c"
    ]);
  });

  it("ignores a focused branch the repo does not list", () => {
    const shown = visibleBranches(all, worktree("wt-primary", "gone"), 2);
    expect(shown.map((b) => b.name)).toEqual(["a", "b"]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(visibleBranches(all, worktree("wt-primary", "target"), 0)).toEqual([]);
  });
});
