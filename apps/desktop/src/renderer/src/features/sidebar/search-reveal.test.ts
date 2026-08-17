import { describe, expect, it } from "vitest";
import type { RepoSearchHit } from "@pwrgit/shared";
import { pendingRevealForSearchHit } from "./search-reveal";

const base = {
  repoId: "repo-1",
  path: "/repos/project",
  profileId: "profile-1",
  profileName: "Profile",
  worktreeCount: 0,
  pinned: false,
  repoName: "project"
};

describe("pendingRevealForSearchHit", () => {
  it("preserves a remote branch while its repository is still loading", () => {
    const hit: RepoSearchHit = {
      ...base,
      kind: "remote_branch",
      name: "releases/1.0",
      remoteName: "origin",
      remoteRef: "refs/remotes/origin/releases/1.0"
    };

    expect(pendingRevealForSearchHit(hit)).toEqual({
      repoId: "repo-1",
      worktreeId: null,
      branch: {
        kind: "remote",
        name: "releases/1.0",
        fullName: "refs/remotes/origin/releases/1.0"
      }
    });
  });

  // A local branch already exists, so the reveal carries no start point — the
  // modal it opens checks the branch out instead of creating it.
  it("preserves a worktree-less local branch by name alone", () => {
    const hit: RepoSearchHit = {
      ...base,
      kind: "local_branch",
      name: "spike/no-checkout"
    };

    expect(pendingRevealForSearchHit(hit)).toEqual({
      repoId: "repo-1",
      worktreeId: null,
      branch: { kind: "local", name: "spike/no-checkout" }
    });
  });

  it("carries no branch action for a checked-out worktree hit", () => {
    const hit: RepoSearchHit = {
      ...base,
      kind: "worktree",
      name: "main",
      worktreeId: "wt-1"
    };

    expect(pendingRevealForSearchHit(hit)).toEqual({
      repoId: "repo-1",
      worktreeId: "wt-1",
      branch: null
    });
  });
});
