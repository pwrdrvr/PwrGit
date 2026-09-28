import { describe, expect, it } from "vitest";
import type { LocalBranchSummary } from "@pwrgit/shared";
import {
  branchMatchesStatus,
  branchStatusCounts,
  goneWithMergedPr
} from "./branch-status";

function branch(
  name: string,
  over: Partial<LocalBranchSummary> = {}
): LocalBranchSummary {
  return {
    name,
    fullName: `refs/heads/${name}`,
    head: "a".repeat(40),
    ahead: 0,
    behind: 0,
    tracking: "up_to_date",
    checkedOutWorktreeIds: [],
    ...over
  };
}

const pr = (state: "open" | "merged" | "closed") => ({
  number: 1,
  url: "https://example.test/pr/1",
  title: "t",
  state,
  isDraft: false
});

describe("branch status filter", () => {
  const synced = branch("main");
  const ahead = branch("feat/a", { ahead: 3, tracking: "ahead" });
  const diverged = branch("fix/d", { ahead: 1, behind: 4, tracking: "diverged" });
  const behind = branch("fix/b", { behind: 2, tracking: "behind" });
  const gone = branch("fix/g", { tracking: "upstream_missing", pr: pr("merged") });
  const goneClosed = branch("spike/g", { tracking: "upstream_missing", pr: pr("closed") });
  const local = branch("wip", { tracking: "unpublished" });
  const all = [synced, ahead, diverged, behind, gone, goneClosed, local];

  it("counts a diverged branch as both to push and behind, like the header does", () => {
    expect(branchMatchesStatus(diverged, "ahead")).toBe(true);
    expect(branchMatchesStatus(diverged, "behind")).toBe(true);
    expect(all.filter((b) => branchMatchesStatus(b, "ahead")).map((b) => b.name))
      .toEqual(["feat/a", "fix/d"]);
  });

  it("counts every filter in one pass", () => {
    expect(branchStatusCounts(all)).toEqual({
      all: 7,
      ahead: 2,
      behind: 2,
      gone: 2,
      unpublished: 1
    });
  });

  it("leads the Gone banner only with merged pull requests", () => {
    expect(goneWithMergedPr(all)).toBe(1);
  });
});
