import { describe, expect, it } from "vitest";
import type { LaneBranchInfo, PrSummary } from "@pwrgit/shared";
import {
  commitUrlForPullRequest,
  pullRequestsAtCommit
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
