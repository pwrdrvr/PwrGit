import { describe, expect, it } from "vitest";
import type { RepoSearchHit, Worktree } from "@pwrgit/shared";
import {
  pendingRevealForCreatedWorktree,
  pendingRevealForSearchHit,
  resolveWorktreeReveal
} from "./search-reveal";

const worktree = (id: string, isPrimary = false): Worktree => ({
  id,
  repoId: "repo-1",
  branch: id,
  path: `/wt/${id}`,
  dirty: 0,
  ahead: 0,
  behind: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: false,
  pinned: false,
  isPrimary
});

describe("pendingRevealForSearchHit", () => {
  it("preserves a remote branch while its repository is still loading", () => {
    const hit: RepoSearchHit = {
      kind: "remote_branch",
      repoId: "repo-1",
      name: "releases/1.0",
      path: "/repos/project",
      profileId: "profile-1",
      profileName: "Profile",
      worktreeCount: 0,
      pinned: false,
      repoName: "project",
      remoteName: "origin",
      remoteRef: "refs/remotes/origin/releases/1.0"
    };

    expect(pendingRevealForSearchHit(hit)).toEqual({
      repoId: "repo-1",
      worktreeId: null,
      remoteBranch: {
        name: "releases/1.0",
        fullName: "refs/remotes/origin/releases/1.0"
      }
    });
  });
});

describe("resolveWorktreeReveal", () => {
  const trees = [worktree("main", true), worktree("feature")];

  it("selects the named worktree", () => {
    expect(
      resolveWorktreeReveal(
        { repoId: "repo-1", worktreeId: "feature", remoteBranch: null },
        trees
      )
    ).toEqual({ kind: "select", worktreeId: "feature" });
  });

  it("stands in with the primary when no worktree was named", () => {
    expect(
      resolveWorktreeReveal(
        { repoId: "repo-1", worktreeId: null, remoteBranch: null },
        trees
      )
    ).toEqual({ kind: "select", worktreeId: "main" });
  });

  it("stands in with the primary when a named worktree is gone", () => {
    expect(
      resolveWorktreeReveal(
        { repoId: "repo-1", worktreeId: "removed", remoteBranch: null },
        trees
      )
    ).toEqual({ kind: "select", worktreeId: "main" });
  });

  it("waits for a created worktree instead of selecting the primary", () => {
    expect(
      resolveWorktreeReveal(
        pendingRevealForCreatedWorktree("repo-1", "fresh"),
        trees
      )
    ).toEqual({ kind: "wait" });
  });

  it("selects the created worktree once the tree lists it", () => {
    expect(
      resolveWorktreeReveal(pendingRevealForCreatedWorktree("repo-1", "fresh"), [
        ...trees,
        worktree("fresh")
      ])
    ).toEqual({ kind: "select", worktreeId: "fresh" });
  });

  it("has nothing to select in a repo with no worktrees", () => {
    expect(
      resolveWorktreeReveal(
        { repoId: "repo-1", worktreeId: null, remoteBranch: null },
        []
      )
    ).toEqual({ kind: "none" });
  });
});
