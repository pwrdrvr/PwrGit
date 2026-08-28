import { describe, expect, it } from "vitest";
import type { CommandRunner, CommandResult } from "./command.js";
import {
  forgeTargetIdentities,
  githubSnapshotFromJson,
  githubStatus,
  gitlabSnapshotFromJson,
  gitlabStatus,
  loadGitlabPipelineJobs,
  summarizeChecks
} from "./forge-status.js";
import type { RemoteIdentity, RemoteSummary } from "./types.js";

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

function result(value: unknown): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function failed(): CommandResult {
  return { exitCode: 1, stdout: "", stderr: "unavailable" };
}

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

  it("treats allowed GitLab failures and manual jobs as non-blocking", () => {
    const snapshot = gitlabSnapshotFromJson({
      mergeRequest: {
        iid: 8,
        web_url: "https://gitlab.com/acme/team/widget/-/merge_requests/8",
        state: "opened",
        source_branch: "feature/live",
        target_branch: "main"
      },
      approvals: { approvals_left: 0, approved_by: [] },
      jobs: [
        { status: "failed", allow_failure: true },
        { status: "manual", allow_failure: true },
        { status: "success", allow_failure: false }
      ],
      identity: gitlabIdentity,
      sourceBranch: "feature/live"
    });

    expect(snapshot.ci).toMatchObject({
      state: "success",
      total: 3,
      succeeded: 1,
      failed: 0,
      pending: 0,
      skipped: 2
    });
  });

  it("searches an upstream GitHub target and rejects another fork's same-named branch", async () => {
    const source: RemoteIdentity = {
      provider: "github",
      host: "github.com",
      path: "fork/widget"
    };
    const remotes: RemoteSummary[] = [
      { ...source, name: "origin", role: "canonical" },
      {
        provider: "github",
        host: "github.com",
        path: "upstream/widget",
        name: "upstream",
        role: "upstream"
      }
    ];
    const targets = forgeTargetIdentities(remotes, source);
    const headOid = "a".repeat(40);
    const calls: string[][] = [];
    const runner: CommandRunner = async (command, args) => {
      expect(command).toBe("gh");
      calls.push([...args]);
      return result([
        {
          number: 1,
          url: "https://github.com/upstream/widget/pull/1",
          state: "OPEN",
          headRefName: "feature/live",
          headRefOid: headOid,
          headRepository: { nameWithOwner: "someone-else/widget" }
        },
        {
          number: 2,
          url: "https://github.com/upstream/widget/pull/2",
          state: "OPEN",
          headRefName: "feature/live",
          headRefOid: "b".repeat(40),
          headRepository: { nameWithOwner: "fork/widget" }
        },
        {
          number: 3,
          url: "https://github.com/upstream/widget/pull/3",
          state: "OPEN",
          headRefName: "feature/live",
          headRefOid: headOid,
          headRepository: { nameWithOwner: "fork/widget" },
          baseRefName: "main",
          latestReviews: [],
          statusCheckRollup: []
        }
      ]);
    };

    const status = await githubStatus(
      "/repo",
      source,
      targets,
      "feature/live",
      headOid,
      runner
    );

    expect(targets.map((target) => target.path)).toEqual([
      "upstream/widget",
      "fork/widget"
    ]);
    expect(status.available).toBe(true);
    expect(status.snapshot.changeRequest).toMatchObject({
      repository: "upstream/widget",
      number: 3
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("upstream/widget");
  });

  it("loads GitLab MR detail, filters source identity and SHA, and paginates jobs", async () => {
    const source: RemoteIdentity = {
      provider: "gitlab",
      host: "gitlab.com",
      path: "fork/widget"
    };
    const target: RemoteIdentity = {
      provider: "gitlab",
      host: "gitlab.com",
      path: "upstream/widget"
    };
    const headOid = "c".repeat(40);
    const endpoints: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      expect(command).toBe("glab");
      const endpoint = args[1] ?? "";
      endpoints.push(endpoint);
      if (endpoint === "projects/fork%2Fwidget") return result({ id: 11 });
      if (endpoint.startsWith("projects/upstream%2Fwidget/merge_requests?")) {
        return result([
          {
            iid: 4,
            source_project_id: 99,
            source_branch: "feature/live",
            sha: headOid
          },
          {
            iid: 5,
            source_project_id: 11,
            source_branch: "feature/live",
            sha: "d".repeat(40)
          },
          {
            iid: 6,
            source_project_id: 11,
            source_branch: "feature/live",
            sha: headOid
          }
        ]);
      }
      if (
        endpoint ===
        "projects/upstream%2Fwidget/merge_requests/6?with_merge_status_recheck=true"
      ) {
        return result({
          iid: 6,
          web_url: "https://gitlab.com/upstream/widget/-/merge_requests/6",
          state: "opened",
          source_project_id: 11,
          source_branch: "feature/live",
          target_branch: "main",
          sha: headOid,
          head_pipeline: { id: 77, project_id: 22 }
        });
      }
      if (endpoint === "projects/upstream%2Fwidget/merge_requests/6/approvals") {
        return result({ approvals_left: 0, approved_by: [] });
      }
      if (endpoint === "projects/22/pipelines/77/jobs?per_page=100&page=1") {
        return result(
          Array.from({ length: 100 }, () => ({
            status: "success",
            allow_failure: false
          }))
        );
      }
      if (endpoint === "projects/22/pipelines/77/jobs?per_page=100&page=2") {
        return result([
          { status: "failed", allow_failure: true },
          { status: "running", allow_failure: false }
        ]);
      }
      throw new Error(`unexpected endpoint: ${endpoint}`);
    };

    const status = await gitlabStatus(
      "/repo",
      source,
      [target, source],
      "feature/live",
      headOid,
      runner
    );

    expect(status.available).toBe(true);
    expect(status.snapshot.changeRequest).toMatchObject({
      repository: "upstream/widget",
      number: 6
    });
    expect(status.snapshot.ci).toMatchObject({
      state: "running",
      total: 102,
      succeeded: 100,
      running: 1,
      skipped: 1
    });
    expect(endpoints).toContain(
      "projects/upstream%2Fwidget/merge_requests/6?with_merge_status_recheck=true"
    );
    expect(endpoints).toContain("projects/22/pipelines/77/jobs?per_page=100&page=2");
  });

  it("marks GitLab follow-up failures as unavailable and unknown", async () => {
    const source = gitlabIdentity;
    const headOid = "e".repeat(40);
    const runner: CommandRunner = async (_command, args) => {
      const endpoint = args[1] ?? "";
      if (endpoint === "projects/acme%2Fteam%2Fwidget") return result({ id: 12 });
      if (endpoint.startsWith("projects/acme%2Fteam%2Fwidget/merge_requests?")) {
        return result([
          {
            iid: 9,
            source_project_id: 12,
            source_branch: "feature/live",
            sha: headOid
          }
        ]);
      }
      if (
        endpoint ===
        "projects/acme%2Fteam%2Fwidget/merge_requests/9?with_merge_status_recheck=true"
      ) {
        return result({
          iid: 9,
          web_url: "https://gitlab.com/acme/team/widget/-/merge_requests/9",
          state: "opened",
          source_project_id: 12,
          source_branch: "feature/live",
          sha: headOid,
          head_pipeline: { id: 88, project_id: 12 }
        });
      }
      if (endpoint.endsWith("/approvals")) return failed();
      if (endpoint.includes("/pipelines/88/jobs")) return failed();
      throw new Error(`unexpected endpoint: ${endpoint}`);
    };

    const status = await gitlabStatus(
      "/repo",
      source,
      [source],
      "feature/live",
      headOid,
      runner
    );

    expect(status.available).toBe(false);
    expect(status.snapshot.ci.state).toBe("unknown");
    expect(status.snapshot.reviews.decision).toBe("unknown");
  });

  it("reports oversized GitLab job sets as unavailable instead of omitting pages", async () => {
    let pages = 0;
    const runner: CommandRunner = async () => {
      pages += 1;
      return result(
        Array.from({ length: 100 }, () => ({
          status: "success",
          allow_failure: false
        }))
      );
    };

    const jobs = await loadGitlabPipelineJobs(
      "/repo",
      "22",
      77,
      "gitlab.com",
      runner
    );

    expect(pages).toBe(5);
    expect(jobs).toEqual({ available: false, value: null });
  });
});
