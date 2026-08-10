import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RemoteResetSnapshot, Worktree } from "@pwrgit/shared";
import {
  resetExecutionRequest,
  resetInspectionRequest,
  ResetToRemoteDialog
} from "./ResetToRemoteDialog";

const worktree: Worktree = {
  id: "worktree-1",
  repoId: "repo-1",
  branch: "feature/local",
  path: "/repos/project",
  dirty: 2,
  ahead: 1,
  behind: 0,
  behindDefault: 0,
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: false,
  pinned: false,
  isPrimary: true
};

describe("reset to remote dialog", () => {
  it("states soft, hard, untracked, and commit-reachability effects precisely", () => {
    const markup = renderToStaticMarkup(
      <ResetToRemoteDialog
        worktree={worktree}
        onClose={() => undefined}
        onComplete={() => undefined}
      />
    );

    expect(markup).toContain("without changing the index or working tree");
    expect(markup).toContain("discards tracked staged and unstaged changes");
    expect(markup).toContain("Untracked and ignored files are normally left alone");
    expect(markup).toContain("obstructs a tracked path");
    expect(markup).toContain("This does not run git clean");
    expect(markup).toContain("Any local commits that are not reachable from that target");
    expect(markup).toContain("reflog may retain them temporarily");
  });

  it("wires only the selected full remote ref and reviewed snapshot", () => {
    const snapshot: RemoteResetSnapshot = {
      branch: "feature/local",
      head: "1".repeat(40),
      remoteRef: "refs/remotes/upstream/release/next",
      remoteHead: "2".repeat(40)
    };

    expect(resetInspectionRequest(worktree.id, snapshot.remoteRef)).toEqual({
      worktreeId: "worktree-1",
      remoteRef: "refs/remotes/upstream/release/next"
    });
    expect(resetExecutionRequest(worktree.id, "hard", snapshot)).toEqual({
      worktreeId: "worktree-1",
      mode: "hard",
      ...snapshot
    });
  });
});
