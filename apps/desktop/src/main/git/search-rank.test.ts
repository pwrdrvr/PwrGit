import type { RepoSearchHit } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import {
  pathLeafLikePatterns,
  rankSearchHits,
  searchMatchTier
} from "./search-rank";

const hit = (partial: Partial<RepoSearchHit>): RepoSearchHit => ({
  kind: "worktree",
  repoId: "r1",
  name: "feat/graph-x",
  path: "/wt/PwrSnap/graph-x",
  profileId: "p1",
  profileName: "Personal",
  worktreeCount: 0,
  pinned: false,
  ...partial
});

const worktree = (branch: string, path: string): RepoSearchHit =>
  hit({ kind: "worktree", name: branch, path, worktreeId: path });

/** A local branch checked out nowhere: its `path` is its REPO's directory. */
const localBranch = (name: string): RepoSearchHit =>
  hit({ kind: "local_branch", name, path: "/repos/PwrSnap" });

describe("searchMatchTier", () => {
  it("counts a worktree's directory name as one of its names", () => {
    const wt = worktree(
      "dmg-file-art-update-4fd193",
      "/Users/me/claude-worktrees/PwrSnap/recursing-euler-9edf74"
    );
    expect(searchMatchTier(wt, "recursing-euler-9edf74")).toBe(0);
    expect(searchMatchTier(wt, "recursing")).toBe(1);
    expect(searchMatchTier(wt, "dmg-file-art-update-4fd193")).toBe(0);
    // Matched, but not by the head of either name — bm25 keeps that ordering.
    expect(searchMatchTier(wt, "euler")).toBe(2);
    expect(searchMatchTier(wt, "claude-worktrees")).toBe(2);
  });

  // A branch checked out nowhere carries its repo's path, not its own. Reading
  // a name out of it would make every branch in a repo an exact match for that
  // repo's folder.
  it("reads no name out of a branch hit's path", () => {
    expect(searchMatchTier(localBranch("spike/idea"), "PwrSnap")).toBe(2);
    expect(searchMatchTier(localBranch("spike/idea"), "spike/idea")).toBe(0);
  });

  it("ignores case, surrounding space and diacritics", () => {
    expect(searchMatchTier(localBranch("Feature/Café"), "  feature/cafe ")).toBe(
      0
    );
  });
});

describe("rankSearchHits", () => {
  // The report this exists for: a checkout the user searched for by the
  // directory their shell was sitting in, ranked below the discarded branch
  // that directory had been named after.
  it("puts a checkout above a branch that is checked out nowhere", () => {
    const wt = worktree(
      "dmg-file-art-update-4fd193",
      "/Users/me/claude-worktrees/PwrSnap/recursing-euler-9edf74"
    );
    const stale = localBranch("recursing-euler-9edf74");

    // Both are named by the query — bm25 has no way to know the second one
    // exists nowhere on disk, and ordered it first (name column, weight 10).
    expect(rankSearchHits([stale, wt], "recursing")).toEqual([wt, stale]);
    expect(rankSearchHits([stale, wt], "recursing-euler-9edf74")).toEqual([
      wt,
      stale
    ]);
  });

  it("still puts the more directly named hit first, whatever its kind", () => {
    const named = localBranch("recursing-euler-9edf74");
    const prefixed = worktree("main", "/wt/PwrSnap/recursing-euler-9edf74-old");
    // "recursing-euler-9edf74" IS the branch and merely begins the directory.
    expect(rankSearchHits([prefixed, named], "recursing-euler-9edf74")).toEqual([
      named,
      prefixed
    ]);
  });

  // Tier 2 is "matched somewhere else entirely" — a branch matched by its name
  // must stay above a worktree matched only by an ancestor directory of its
  // path, which is exactly what bm25's column weights already express.
  it("leaves the index's ordering alone where nothing was named", () => {
    const branch = localBranch("worktrees/cleanup");
    const deep = worktree("main", "/Users/me/claude-worktrees/PwrSnap/api");
    expect(rankSearchHits([branch, deep], "worktrees")).toEqual([branch, deep]);
  });

  it("keeps bm25's order between two equally-named checkouts", () => {
    const first = worktree("release", "/wt/a/release");
    const second = hit({ kind: "repo", name: "release", path: "/repos/release" });
    expect(rankSearchHits([first, second], "release")).toEqual([first, second]);
    expect(rankSearchHits([second, first], "release")).toEqual([second, first]);
  });
});

describe("pathLeafLikePatterns", () => {
  it("matches a path whose last segment is the query, on either platform", () => {
    expect(pathLeafLikePatterns(" graph-x ")).toEqual([
      "%/graph-x",
      "%\\\\graph-x"
    ]);
  });

  // `_` is LIKE's single-character wildcard and is ordinary in a branch name:
  // unescaped, "wip_1" would claim "wip1" as an exact folder match.
  it("escapes LIKE's own wildcards", () => {
    expect(pathLeafLikePatterns("wip_1%")).toEqual([
      "%/wip\\_1\\%",
      "%\\\\wip\\_1\\%"
    ]);
  });
});
