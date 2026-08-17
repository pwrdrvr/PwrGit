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

describe("resolveWorktreeReveal", () => {
  const trees = [worktree("main", true), worktree("feature")];

  it("selects the named worktree", () => {
    expect(
      resolveWorktreeReveal(
        { repoId: "repo-1", worktreeId: "feature", branch: null },
        trees
      )
    ).toEqual({ kind: "select", worktreeId: "feature" });
  });

  it("stands in with the primary when no worktree was named", () => {
    expect(
      resolveWorktreeReveal(
        { repoId: "repo-1", worktreeId: null, branch: null },
        trees
      )
    ).toEqual({ kind: "select", worktreeId: "main" });
  });

  it("stands in with the primary when a named worktree is gone", () => {
    expect(
      resolveWorktreeReveal(
        { repoId: "repo-1", worktreeId: "removed", branch: null },
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
        { repoId: "repo-1", worktreeId: null, branch: null },
        []
      )
    ).toEqual({ kind: "none" });
  });
});
