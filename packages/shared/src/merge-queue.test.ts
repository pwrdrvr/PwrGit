import { describe, expect, it } from "vitest";
import {
  isMergeQueueBranchName,
  isMergeQueueRemoteRef,
  mergeQueueLabel,
  mergeQueueRemovalReason
} from "./merge-queue";

describe("merge-group refs", () => {
  it("matches GitHub's merge-group branches on any remote, full or short", () => {
    const head = "gh-readonly-queue/main/pr-26470-0123456789abcdef0123456789abcdef01234567";
    expect(isMergeQueueRemoteRef(`refs/remotes/origin/${head}`)).toBe(true);
    expect(isMergeQueueRemoteRef(`origin/${head}`)).toBe(true);
    // A remote named with a slash is split by callers that know the remotes
    // (`isMergeQueueBranchName` on the branch part); alone, the first segment
    // is the remote.
    expect(isMergeQueueRemoteRef(`refs/remotes/team/fork/${head}`)).toBe(false);
    expect(isMergeQueueBranchName(head)).toBe(true);
    expect(isMergeQueueBranchName("gh-readonly-queue/release/v2/pr-1-abc")).toBe(true);
  });

  it("leaves local branches and look-alikes alone", () => {
    expect(isMergeQueueRemoteRef("refs/heads/gh-readonly-queue/main/pr-1-abc")).toBe(false);
    expect(isMergeQueueRemoteRef("refs/remotes/origin/gh-readonly-queue")).toBe(false);
    expect(isMergeQueueRemoteRef("refs/remotes/origin/feature/queue")).toBe(false);
    expect(isMergeQueueBranchName("feature/gh-readonly-queue/main/x")).toBe(false);
    expect(isMergeQueueRemoteRef("refs/remotes/origin/infra/gh-readonly-queue/main/notes")).toBe(false);
    expect(isMergeQueueRemoteRef("origin/infra/gh-readonly-queue/main/notes")).toBe(false);
  });
});

describe("queue wording", () => {
  it("names a place and a reason", () => {
    expect(mergeQueueLabel({ kind: "queued", position: 2, etaSeconds: 240, merging: false, failing: false }))
      .toBe("queued #2 · ~4 min");
    expect(mergeQueueLabel({ kind: "group_checks_running", position: 1 }))
      .toBe("queued #1 · merge group checks running");
    expect(mergeQueueLabel({ kind: "removed", reason: "failed_checks", canRequeue: false }))
      .toBe("removed from queue · merge group checks failed");
    expect(mergeQueueRemovalReason("SOMETHING_NEW")).toBe("something new");
    expect(mergeQueueRemovalReason("  ")).toBeUndefined();
  });
});
