import { describe, expect, it } from "vitest";
import type { BranchRef } from "@pwrgit/shared";
import { switchTarget, switcherRows } from "./branch-switcher-model";

const local = (name: string, upstream?: string, isCurrent = false): BranchRef => ({
  name,
  isRemote: false,
  isCurrent,
  ...(upstream === undefined ? {} : { upstream })
});
const remote = (remoteName: string, branch: string): BranchRef => ({
  name: `${remoteName}/${branch}`,
  isRemote: true,
  isCurrent: false,
  remote: remoteName,
  remoteBranch: branch
});

// The disktree report: main tracks origin, and pwrdisk and upstream both
// carry a main of their own.
const branches: BranchRef[] = [
  local("main", "origin/main", true),
  local("fix/pwrdisk-mark", "pwrdisk/main"),
  remote("origin", "main"),
  remote("pwrdisk", "main"),
  remote("upstream", "main"),
  remote("origin", "feature/remote-only"),
  remote("team/fork", "main")
];

const shape = (query: string) =>
  switcherRows(branches, query).map((row) => ({
    name: row.ref.name,
    alternates: row.alternates.map((alt) => alt.name),
    searchPick: row.searchPick?.name ?? null
  }));

describe("switcherRows", () => {
  it("folds another remote's same-named branch into the local row instead of hiding it", () => {
    expect(shape("")).toEqual([
      { name: "main", alternates: ["pwrdisk/main", "upstream/main", "team/fork/main"], searchPick: null },
      { name: "fix/pwrdisk-mark", alternates: [], searchPick: null },
      { name: "origin/feature/remote-only", alternates: [], searchPick: null }
    ]);
  });

  it("lands a search for another remote's copy on the local row, with that copy chosen", () => {
    expect(shape("pwrdisk/main")).toEqual([
      { name: "main", alternates: ["pwrdisk/main", "upstream/main", "team/fork/main"], searchPick: "pwrdisk/main" },
      // Matched through its upstream text, so nothing is chosen for it.
      { name: "fix/pwrdisk-mark", alternates: [], searchPick: null }
    ]);
    expect(shape("main")[0]).toMatchObject({ name: "main", searchPick: null });
  });

  it("keeps a remote branch the user has no local name for as its own row", () => {
    expect(shape("remote-only").map((row) => row.name)).toEqual(["origin/feature/remote-only"]);
  });

  it("switches to a remote row by its name on the remote, even when the remote has a slash", () => {
    expect(switchTarget(remote("team/fork", "feature/x"))).toBe("feature/x");
    expect(switchTarget({ name: "gone/feature", isRemote: true, isCurrent: false })).toBe("feature");
  });
});
