import { describe, expect, it } from "vitest";
import {
  removalStatus,
  type RemovalCheckout,
  type Repo,
  type RepoRemovalReview
} from "@pwrgit/shared";
import {
  checkoutFacts,
  hiddenToast,
  pushOffReason,
  removeButtonLabel,
  resultHeadline,
  statusLine,
  stepLabel
} from "./remove-repo-view";

const checkout = (over: Partial<RemovalCheckout> = {}): RemovalCheckout => ({
  worktreeId: "wt",
  branch: "feat/x",
  head: "abcdef1234",
  path: "/src/harbor-api-x",
  isPrimary: false,
  missing: false,
  locked: false,
  uncommitted: 0,
  untracked: 0,
  conflicted: 0,
  unpushed: 0,
  upstream: "origin/feat/x",
  inProgress: null,
  pushRemote: "origin",
  bytes: 1024 * 1024,
  bytesPartial: false,
  inspectError: null,
  ...over
});

const primary = checkout({ worktreeId: "main", branch: "main", isPrimary: true, path: "/src/harbor-api" });

const review = (checkouts: RemovalCheckout[]): RepoRemovalReview => ({
  repoId: "r",
  profileId: "p",
  name: "harbor-api",
  path: "/src/harbor-api",
  remotes: [],
  checkouts,
  stashes: { count: 0, newestSubject: null, newestAt: null },
  branches: [],
  reviewedAt: ""
});

describe("remove-repo-view", () => {
  it("says what the review found, in one line", () => {
    expect(checkoutFacts(checkout())).toBe("Clean. Matches origin/feat/x.");
    expect(checkoutFacts(checkout({ upstream: null, unpushed: 2 }))).toBe("2 commits, never pushed");
    expect(checkoutFacts(checkout({ uncommitted: 1, untracked: 4 }))).toBe(
      "1 uncommitted file · 4 untracked files"
    );
    expect(checkoutFacts(checkout({ inProgress: "merge" }))).toBe(
      "A merge is in progress. Finish or abort the merge first."
    );
    expect(checkoutFacts(checkout({ missing: true }))).toContain("not mounted");
  });

  it("explains why Push first is missing", () => {
    expect(pushOffReason(checkout({ unpushed: 2 }))).toBeNull();
    expect(pushOffReason(checkout({ unpushed: 1, branch: "" }))).toBe(
      "Push first is off: a detached HEAD has no branch to push the 1 commit to."
    );
    expect(pushOffReason(checkout({ unpushed: 1, pushRemote: null }))).toBe(
      "Push first is off: this repository has no remote to push the 1 commit to."
    );
  });

  it("names the button for what it will do", () => {
    const clean = review([checkout(), primary]);
    expect(removeButtonLabel(clean, removalStatus(clean, { checkouts: {}, branches: {} }))).toBe(
      "Move 2 folders to Trash"
    );
    const kept = review([checkout({ uncommitted: 1 }), checkout({ worktreeId: "b" }), primary]);
    const status = removalStatus(kept, { checkouts: { wt: "keep" }, branches: {} });
    expect(removeButtonLabel(kept, status)).toBe("Remove 1 worktree");
    expect(statusLine(status)).toBe("1 safe");
    expect(
      statusLine(removalStatus(kept, { checkouts: {}, branches: {} }))
    ).toBe("1 needs a choice · 2 safe");
  });

  it("reports each outcome", () => {
    const r = review([checkout(), primary]);
    const step = { id: "wt", kind: "trash" as const, worktreeId: "wt", label: "feat/x", path: "/src/harbor-api-x", isPrimary: false };
    expect(stepLabel({ ...step, status: "pending" })).toBe("feat/x to the Trash");
    expect(
      resultHeadline(r, {
        outcome: "stopped",
        steps: [{ ...step, status: "failed" }, { ...step, id: "main", worktreeId: "main", isPrimary: true, status: "skipped" }]
      }).title
    ).toBe("Stopped: 1 folder could not be moved");
    expect(resultHeadline(r, { outcome: "partial", steps: [{ ...step, status: "done" }] })).toEqual({
      title: "Removed 1 worktree",
      message: "1 folder, 1 MB, is in the Trash. harbor-api stays in PwrGit."
    });
  });

  it("tells the hide toast how many worktrees went with it", () => {
    const repo: Repo = { id: "r", name: "harbor-api", path: "/x", profileId: "p", pinned: false, worktrees: [] };
    expect(hiddenToast(repo)).toEqual({
      title: "Hid harbor-api",
      message: "It stays on disk and out of this profile's sidebar, search, Fetch all and Try pull all."
    });
    const worktree = { repoId: "r", path: "/y", branch: "b", dirty: 0, ahead: 0, behind: 0, pinned: false, isPrimary: false } as Repo["worktrees"][number];
    expect(hiddenToast({ ...repo, worktrees: [worktree, { ...worktree, id: "2" }] }).message).toContain(
      "Its 2 worktrees are hidden with it."
    );
  });
});
