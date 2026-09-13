import { describe, expect, it } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import { retainOrder } from "./hover-stable-order";
import { filterReposByLens } from "./repo-view";

describe("retainOrder", () => {
  it("passes the list straight through when nothing is held", () => {
    expect(retainOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("holds the positions it froze, whatever the list now says", () => {
    expect(retainOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual([
      "a",
      "b",
      "c"
    ]);
  });

  it("lands a newcomer at the bottom, where it moves nothing", () => {
    expect(retainOrder(["a", "b"], ["new", "a", "b"])).toEqual([
      "a",
      "b",
      "new"
    ]);
  });

  it("keeps newcomers in the order the list wants them", () => {
    expect(retainOrder(["a"], ["y", "a", "x"])).toEqual(["a", "y", "x"]);
  });

  it("drops a row that left the list rather than printing a ghost", () => {
    expect(retainOrder(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c"]);
  });
});

// The bug this file exists for, in the terms the lens itself uses: selecting a
// worktree makes its repo `current`, which is rank 0 of the Focus ladder, so
// the row the user just clicked leaves from under the cursor and every row
// between its old and new home shifts. Holding the frozen order is what stops
// the list re-sorting itself in response to being read.
describe("the Focused lens under a click", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-09-12T00:00:00.000Z");

  const worktree = (id: string, agoDays: number): Worktree => ({
    id,
    repoId: id.slice(0, 1),
    branch: "main",
    path: `/${id}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: true,
    pinned: false,
    isPrimary: true,
    lastActivityAt: new Date(now - agoDays * DAY).toISOString()
  });

  const repo = (id: string, agoDays: number): Repo => ({
    id,
    name: id,
    path: `/${id}`,
    profileId: "p",
    pinned: false,
    worktrees: [worktree(`${id}1`, agoDays)]
  });

  const repos = [repo("a", 3), repo("b", 2), repo("c", 1)];
  const lensOrder = (selectedWorktreeId: string | null): string[] =>
    filterReposByLens(repos, "Focused", now, {
      selectedWorktreeId,
      visits: {}
    }).map((r) => r.id);

  it("really does re-sort the row that was clicked to the top", () => {
    expect(lensOrder(null)).toEqual(["c", "b", "a"]);
    expect(lensOrder("a1")).toEqual(["a", "c", "b"]);
  });

  it("leaves the clicked row exactly where the pointer found it", () => {
    const held = lensOrder(null);
    expect(retainOrder(held, lensOrder("a1"))).toEqual(held);
  });
});
