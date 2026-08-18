import { describe, expect, it } from "vitest";
import type { LaneBranchInfo, PrSummary } from "@pwrgit/shared";
import {
  branchRefsAtCommit,
  commitUrlForPullRequest,
  MAX_COMMIT_BRANCH_ITEMS,
  pullRequestsAtCommit,
  switchFailureMessage,
  switchTargetsAtCommit
} from "./commit-context-menu";

const featurePr: PrSummary = {
  number: 42,
  url: "https://github.com/pwrdrvr/PwrGit/pull/42/files",
  title: "Context menu",
  state: "open",
  isDraft: false
};

describe("pullRequestsAtCommit", () => {
  it("uses exact local or remote tip names and deduplicates a shared PR", () => {
    const otherPr: PrSummary = {
      ...featurePr,
      number: 43,
      url: "https://github.com/pwrdrvr/PwrGit/pull/43"
    };
    const branchInfo: Record<string, LaneBranchInfo> = {
      "feature/context": { pr: featurePr },
      "feature/other": { pr: otherPr }
    };

    expect(
      pullRequestsAtCommit(
        ["feature/context"],
        ["origin/feature/context", "upstream/feature/other"],
        branchInfo
      )
    ).toEqual([featurePr, otherPr]);
  });

  it("ignores branches without a usable cached pull-request URL", () => {
    expect(
      pullRequestsAtCommit(["feature/offline"], [], {
        "feature/offline": {
          pr: { ...featurePr, url: "" }
        }
      })
    ).toEqual([]);
  });
});

describe("commitUrlForPullRequest", () => {
  it("turns a GitHub pull-request URL into its commit permalink", () => {
    expect(commitUrlForPullRequest(featurePr, "abc123")).toBe(
      "https://github.com/pwrdrvr/PwrGit/commit/abc123"
    );
  });

  it("supports GitLab merge-request URLs and rejects unrelated URLs", () => {
    expect(
      commitUrlForPullRequest(
        {
          ...featurePr,
          number: 7,
          url: "https://gitlab.example/group/repo/-/merge_requests/7"
        },
        "abc123"
      )
    ).toBe("https://gitlab.example/group/repo/-/commit/abc123");
    expect(
      commitUrlForPullRequest(
        { ...featurePr, url: "https://github.com/pwrdrvr/PwrGit/issues/42" },
        "abc123"
      )
    ).toBeNull();
  });
});

describe("switchTargetsAtCommit", () => {
  const branchInfo: Record<string, LaneBranchInfo> = {
    "feature/held": { worktreeId: "worktree-2", worktreePath: "/wt/held" },
    main: { worktreeId: "worktree-1", worktreePath: "/repo" }
  };

  it("offers every branch here except the one already checked out", () => {
    expect(
      switchTargetsAtCommit(
        ["main", "feature/ready"],
        [],
        branchInfo,
        "main",
        "worktree-1"
      )
    ).toEqual([
      { branch: "feature/ready", ref: "feature/ready", isRemoteOnly: false }
    ]);
  });

  it("resolves a remote tip to its local branch and skips a collapsed chip", () => {
    expect(
      switchTargetsAtCommit(
        ["feature/ready"],
        ["origin", "origin/feature/theirs"],
        {},
        "main",
        "worktree-1"
      )
    ).toEqual([
      { branch: "feature/ready", ref: "feature/ready", isRemoteOnly: false },
      {
        branch: "feature/theirs",
        ref: "origin/feature/theirs",
        isRemoteOnly: true
      }
    ]);
  });

  it("drops a remote ref whose local branch is already listed", () => {
    expect(
      switchTargetsAtCommit(
        ["feature/ready"],
        ["origin/feature/ready"],
        {},
        "main",
        "worktree-1"
      )
    ).toHaveLength(1);
  });

  it("marks a branch another worktree holds, since git refuses that switch", () => {
    expect(
      switchTargetsAtCommit(["feature/held"], [], branchInfo, "main", "worktree-1")
    ).toEqual([
      {
        branch: "feature/held",
        ref: "feature/held",
        isRemoteOnly: false,
        checkedOutIn: "worktree-2"
      }
    ]);
  });

  it("caps a commit tipped by more branches than a menu should list", () => {
    const many = ["b1", "b2", "b3", "b4", "b5", "b6"];
    expect(
      switchTargetsAtCommit(many, [], {}, "main", "worktree-1")
    ).toHaveLength(MAX_COMMIT_BRANCH_ITEMS);
  });
});

describe("branchRefsAtCommit", () => {
  it("lists local and full remote refs, dropping a collapsed remote chip", () => {
    expect(branchRefsAtCommit(["main"], ["origin", "upstream/main"])).toEqual([
      "main",
      "upstream/main"
    ]);
  });
});

describe("switchFailureMessage", () => {
  it("explains the two refusals a graph click can walk into", () => {
    expect(
      switchFailureMessage(
        { kind: "repo", code: "dirty", message: "error: your local changes…" },
        "feature/x"
      )
    ).toContain("uncommitted changes");
    expect(
      switchFailureMessage(
        {
          kind: "repo",
          code: "checked_out_elsewhere",
          message: "fatal: already used by worktree…"
        },
        "feature/x"
      )
    ).toBe("feature/x is already checked out in another worktree.");
  });

  it("keeps git's own first line for anything else", () => {
    expect(
      switchFailureMessage(
        {
          kind: "repo",
          code: "switch_failed",
          message: "fatal: invalid reference\nmore detail"
        },
        "feature/x"
      )
    ).toBe("fatal: invalid reference");
  });
});
