import { describe, expect, it } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import { claimWorktreeOwnership } from "./repo-ownership";

const wt = (id: string, path: string, isPrimary: boolean): Worktree => ({
  id,
  repoId: "",
  branch: "main",
  path,
  dirty: 0,
  ahead: 0,
  behind: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  pinned: false,
  isPrimary
});

const repo = (id: string, path: string, worktrees: Worktree[]): Repo => ({
  id,
  name: id,
  path,
  profileId: "p",
  pinned: false,
  worktrees
});

describe("claimWorktreeOwnership", () => {
  it("drops a worktree duplicated under a second repo (fossil DB shape)", () => {
    // codex's primary ALSO appears under the fossil "codex-app-server" repo —
    // the exact state that renders two selected rows at once.
    const codexMain = wt("w-codex", "/gh/codex", true);
    const repos = [
      repo("r-cas", "/gh/codex-app-server", [
        wt("w-codex", "/gh/codex", true),
        wt("w-det", "/gh/cas-det", false)
      ]),
      repo("r-codex", "/gh/codex", [codexMain])
    ];
    const out = claimWorktreeOwnership(repos);
    // The true primary owner (repo.path === worktree.path) wins, even though
    // the fossil repo came first in list order.
    expect(out[0]?.worktrees.map((w) => w.id)).toEqual(["w-det"]);
    expect(out[1]?.worktrees.map((w) => w.id)).toEqual(["w-codex"]);
  });

  it("keeps first-in-order when no repo is the true primary owner", () => {
    const repos = [
      repo("r-a", "/gh/a", [wt("w-x", "/elsewhere/x", false)]),
      repo("r-b", "/gh/b", [wt("w-x", "/elsewhere/x", false)])
    ];
    const out = claimWorktreeOwnership(repos);
    expect(out[0]?.worktrees).toHaveLength(1);
    expect(out[1]?.worktrees).toHaveLength(0);
  });

  it("returns the same reference when nothing is duplicated", () => {
    const repos = [
      repo("r-a", "/gh/a", [wt("w-a", "/gh/a", true)]),
      repo("r-b", "/gh/b", [wt("w-b", "/gh/b", true)])
    ];
    expect(claimWorktreeOwnership(repos)).toBe(repos);
  });
});
