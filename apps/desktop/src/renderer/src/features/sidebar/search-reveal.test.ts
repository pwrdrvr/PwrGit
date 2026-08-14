import { describe, expect, it } from "vitest";
import type { RepoSearchHit } from "@pwrgit/shared";
import { pendingRevealForSearchHit } from "./search-reveal";

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
