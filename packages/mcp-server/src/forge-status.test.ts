import { describe, expect, it } from "vitest";
import {
  githubSnapshotFromJson,
  gitlabSnapshotFromJson,
  summarizeChecks
} from "./forge-status.js";

const githubIdentity = {
  provider: "github" as const,
  host: "github.com",
  path: "acme/widget"
};
const gitlabIdentity = {
  provider: "gitlab" as const,
  host: "gitlab.com",
  path: "acme/team/widget"
};

describe("normalized forge status", () => {
  it("distinguishes a failure while jobs remain from terminal failure", () => {
    expect(summarizeChecks(["failure", "in_progress", "success"]).state).toBe(
      "failure_with_running"
    );
    expect(summarizeChecks(["failure", "success"]).state).toBe(
      "terminal_failure"
    );
    expect(summarizeChecks(["success", "skipped"]).state).toBe("success");
  });

  it("normalizes GitHub CI, conflicts, reviews, and PR state", () => {
    const snapshot = githubSnapshotFromJson(
      {
        number: 42,
        url: "https://github.com/acme/widget/pull/42",
        state: "OPEN",
        isDraft: false,
        headRefName: "feature/live",
        baseRefName: "main",
        mergeStateStatus: "DIRTY",
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [
          {
            author: { login: "reviewer" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-08-23T12:00:00Z"
          }
        ],
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "FAILURE" },
          { status: "IN_PROGRESS", conclusion: "" }
        ]
      },
      githubIdentity,
      "feature/live"
    );
    expect(snapshot).toMatchObject({
      changeRequest: {
        provider: "github",
        number: 42,
        state: "open",
        sourceBranch: "feature/live",
        targetBranch: "main"
      },
      ci: { state: "failure_with_running", failed: 1, running: 1 },
      mergeConflict: true,
      reviews: {
        decision: "changes_requested",
        blocking: true,
        blockingReason: "changes_requested"
      }
    });
  });

  it("treats GitHub's required-review decision as an approval blocker", () => {
    const snapshot = githubSnapshotFromJson(
      {
        number: 43,
        url: "https://github.com/acme/widget/pull/43",
        state: "OPEN",
        isDraft: false,
        headRefName: "feature/review",
        baseRefName: "main",
        mergeStateStatus: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
        latestReviews: [],
        statusCheckRollup: []
      },
      githubIdentity,
      "feature/review"
    );

    expect(snapshot.reviews).toMatchObject({
      decision: "review_required",
      blocking: true,
      blockingReason: "approval_required"
    });
  });

  it("normalizes GitLab pipelines, approvals, discussions, and MR state", () => {
    const snapshot = gitlabSnapshotFromJson({
      mergeRequest: {
        iid: 7,
        web_url: "https://gitlab.com/acme/team/widget/-/merge_requests/7",
        state: "opened",
        draft: false,
        source_branch: "feature/live",
        target_branch: "main",
        detailed_merge_status: "conflict",
        blocking_discussions_resolved: false
      },
      approvals: {
        approvals_left: 1,
        approved_by: [{ user: { username: "reviewer" } }]
      },
      jobs: [{ status: "failed" }, { status: "running" }],
      identity: gitlabIdentity,
      sourceBranch: "feature/live"
    });
    expect(snapshot).toMatchObject({
      changeRequest: { provider: "gitlab", number: 7, state: "open" },
      ci: { state: "failure_with_running", failed: 1, running: 1 },
      mergeConflict: true,
      reviews: {
        decision: "review_required",
        blocking: true,
        blockingReason: "blocking_discussion"
      }
    });
  });
});
