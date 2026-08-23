import type { CommandRunner } from "./command.js";
import { runCommand } from "./command.js";
import {
  readConfiguredRemotes,
  readSafeStatus,
  repositoryRootFor
} from "./git-metadata.js";
import type {
  ChangeRequestState,
  CiSummary,
  LiveStatusSnapshot,
  RemoteIdentity,
  ReviewState,
  ReviewSummary
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const SUCCESS = new Set(["success", "successful", "passed", "neutral"]);
const FAILURE = new Set([
  "action_required",
  "cancelled",
  "canceled",
  "error",
  "failed",
  "failure",
  "stale",
  "timed_out"
]);
const RUNNING = new Set(["in_progress", "running"]);
const PENDING = new Set([
  "created",
  "expected",
  "manual",
  "pending",
  "preparing",
  "queued",
  "requested",
  "scheduled",
  "waiting",
  "waiting_for_resource"
]);
const SKIPPED = new Set(["skipped"]);

export function summarizeChecks(statuses: readonly string[]): CiSummary {
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  let skipped = 0;
  let unknown = 0;
  for (const raw of statuses) {
    const status = raw.trim().toLowerCase();
    if (SUCCESS.has(status)) succeeded += 1;
    else if (FAILURE.has(status)) failed += 1;
    else if (RUNNING.has(status)) running += 1;
    else if (PENDING.has(status)) pending += 1;
    else if (SKIPPED.has(status)) skipped += 1;
    else unknown += 1;
  }
  const total = statuses.length;
  const active = running + pending;
  const state: CiSummary["state"] =
    total === 0
      ? "none"
      : failed > 0 && active > 0
        ? "failure_with_running"
        : failed > 0
          ? "terminal_failure"
          : active > 0
            ? running > 0
              ? "running"
              : "pending"
            : unknown > 0
              ? "unknown"
              : "success";
  return { state, total, succeeded, failed, running, pending, skipped };
}

const EMPTY_REVIEWS: ReviewState = {
  decision: "none",
  blocking: false,
  blockingReason: null,
  latest: []
};

type ForgeSnapshot = {
  changeRequest: ChangeRequestState | null;
  ci: CiSummary;
  mergeConflict: boolean;
  reviews: ReviewState;
};

function emptyForgeSnapshot(): ForgeSnapshot {
  return {
    changeRequest: null,
    ci: summarizeChecks([]),
    mergeConflict: false,
    reviews: EMPTY_REVIEWS
  };
}

function githubCheckStatus(value: unknown): string | null {
  const check = record(value);
  if (check === null) return null;
  const conclusion = string(check.conclusion);
  if (conclusion !== null) return conclusion;
  const state = string(check.state);
  if (state !== null) return state;
  return string(check.status);
}

function reviewState(value: unknown): ReviewSummary["state"] {
  const normalized = string(value)?.toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "changes_requested" || normalized === "request_changes") {
    return "changes_requested";
  }
  if (normalized === "commented" || normalized === "comment") return "commented";
  if (normalized === "dismissed") return "dismissed";
  return "unknown";
}

export function githubSnapshotFromJson(
  value: unknown,
  identity: RemoteIdentity,
  sourceBranch: string
): ForgeSnapshot {
  const pr = record(value);
  if (pr === null) return emptyForgeSnapshot();
  const prNumber = number(pr.number);
  const url = string(pr.url);
  if (prNumber === null || url === null) return emptyForgeSnapshot();
  const rawState = string(pr.state)?.toLowerCase();
  const state: ChangeRequestState["state"] =
    rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
  const latest = Array.isArray(pr.latestReviews)
    ? pr.latestReviews.slice(0, 20).flatMap((entry, index) => {
        const review = record(entry);
        if (review === null) return [];
        const author = record(review.author);
        const submittedAt = string(review.submittedAt);
        const actor = string(author?.login);
        const state = reviewState(review.state);
        return [
          {
            id: `${submittedAt ?? "unknown"}:${actor ?? "unknown"}:${state}:${index}`,
            actor,
            state,
            submittedAt
          } satisfies ReviewSummary
        ];
      })
    : [];
  const decisionRaw = string(pr.reviewDecision)?.toLowerCase();
  const decision: ReviewState["decision"] =
    decisionRaw === "approved"
      ? "approved"
      : decisionRaw === "changes_requested"
        ? "changes_requested"
        : decisionRaw === "review_required"
          ? "review_required"
          : latest.length === 0
            ? "none"
            : "unknown";
  const statuses = Array.isArray(pr.statusCheckRollup)
    ? pr.statusCheckRollup.flatMap((check) => {
        const status = githubCheckStatus(check);
        return status === null ? [] : [status];
      })
    : [];
  return {
    changeRequest: {
      provider: "github",
      host: identity.host,
      repository: identity.path,
      number: prNumber,
      url,
      state,
      draft: boolean(pr.isDraft) ?? false,
      sourceBranch: string(pr.headRefName) ?? sourceBranch,
      targetBranch: string(pr.baseRefName)
    },
    ci: summarizeChecks(statuses),
    mergeConflict: string(pr.mergeStateStatus)?.toLowerCase() === "dirty",
    reviews: {
      decision,
      blocking:
        decision === "changes_requested" || decision === "review_required",
      blockingReason:
        decision === "changes_requested"
          ? "changes_requested"
          : decision === "review_required"
            ? "approval_required"
            : null,
      latest
    }
  };
}

export function gitlabSnapshotFromJson(input: {
  mergeRequest: unknown;
  approvals?: unknown;
  jobs?: unknown;
  identity: RemoteIdentity;
  sourceBranch: string;
}): ForgeSnapshot {
  const mr = record(input.mergeRequest);
  if (mr === null) return emptyForgeSnapshot();
  const iid = number(mr.iid);
  const url = string(mr.web_url);
  if (iid === null || url === null) return emptyForgeSnapshot();
  const rawState = string(mr.state)?.toLowerCase();
  const state: ChangeRequestState["state"] =
    rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
  const approvals = record(input.approvals);
  const approvedBy = Array.isArray(approvals?.approved_by)
    ? approvals.approved_by
    : [];
  const latest = approvedBy.slice(0, 20).flatMap((entry, index) => {
    const approval = record(entry);
    const user = record(approval?.user);
    const actor = string(user?.username) ?? string(user?.name);
    if (actor === null) return [];
    return [
      {
        id: `approval:${actor}:${index}`,
        actor,
        state: "approved",
        submittedAt: null
      } satisfies ReviewSummary
    ];
  });
  const approvalsLeft = number(approvals?.approvals_left);
  const blockingDiscussion = boolean(mr.blocking_discussions_resolved) === false;
  const approvalRequired = approvalsLeft !== null && approvalsLeft > 0;
  const decision: ReviewState["decision"] = approvalRequired
    ? "review_required"
    : latest.length > 0
      ? "approved"
      : "none";
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const statuses = jobs.flatMap((entry) => {
    const status = string(record(entry)?.status);
    return status === null ? [] : [status];
  });
  const detailedMergeStatus =
    string(mr.detailed_merge_status)?.toLowerCase() ??
    string(mr.merge_status)?.toLowerCase();
  const conflict =
    boolean(mr.has_conflicts) === true ||
    detailedMergeStatus === "conflict" ||
    detailedMergeStatus === "cannot_be_merged";
  return {
    changeRequest: {
      provider: "gitlab",
      host: input.identity.host,
      repository: input.identity.path,
      number: iid,
      url,
      state,
      draft: boolean(mr.draft) ?? Boolean(string(mr.title)?.match(/^\s*(?:draft:|wip:)/i)),
      sourceBranch: string(mr.source_branch) ?? input.sourceBranch,
      targetBranch: string(mr.target_branch)
    },
    ci: summarizeChecks(statuses),
    mergeConflict: conflict,
    reviews: {
      decision,
      blocking: approvalRequired || blockingDiscussion,
      blockingReason: blockingDiscussion
        ? "blocking_discussion"
        : approvalRequired
          ? "approval_required"
          : null,
      latest
    }
  };
}

async function jsonCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  runner: CommandRunner
): Promise<{ available: boolean; value: unknown | null }> {
  try {
    const result = await runner(command, args, { cwd, timeoutMs: 15_000 });
    if (result.exitCode !== 0) return { available: false, value: null };
    return { available: true, value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { available: false, value: null };
  }
}

async function githubStatus(
  cwd: string,
  identity: RemoteIdentity,
  branch: string,
  runner: CommandRunner
): Promise<{ available: boolean; snapshot: ForgeSnapshot }> {
  const repository =
    identity.host === "github.com"
      ? identity.path
      : `${identity.host}/${identity.path}`;
  const response = await jsonCommand(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--repo",
      repository,
      "--json",
      "number,url,state,isDraft,headRefName,baseRefName,mergeStateStatus,reviewDecision,latestReviews,statusCheckRollup"
    ],
    cwd,
    runner
  );
  const pullRequest = Array.isArray(response.value) ? response.value[0] : null;
  return {
    available: response.available,
    snapshot:
      pullRequest === null || pullRequest === undefined
        ? emptyForgeSnapshot()
        : githubSnapshotFromJson(pullRequest, identity, branch)
  };
}

async function gitlabStatus(
  cwd: string,
  identity: RemoteIdentity,
  branch: string,
  runner: CommandRunner
): Promise<{ available: boolean; snapshot: ForgeSnapshot }> {
  const project = encodeURIComponent(identity.path);
  const mergeRequests = await jsonCommand(
    "glab",
    [
      "api",
      `projects/${project}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&sort=desc&per_page=1`,
      "--hostname",
      identity.host
    ],
    cwd,
    runner
  );
  if (!mergeRequests.available || !Array.isArray(mergeRequests.value)) {
    return { available: false, snapshot: emptyForgeSnapshot() };
  }
  const mr = mergeRequests.value[0];
  const iid = number(record(mr)?.iid);
  if (mr === undefined || iid === null) {
    return { available: true, snapshot: emptyForgeSnapshot() };
  }
  const pipeline = record(record(mr)?.head_pipeline);
  const pipelineId = number(pipeline?.id);
  const [approvals, jobs] = await Promise.all([
    jsonCommand(
      "glab",
      [
        "api",
        `projects/${project}/merge_requests/${iid}/approvals`,
        "--hostname",
        identity.host
      ],
      cwd,
      runner
    ),
    pipelineId === null
      ? Promise.resolve({ available: true, value: [] as unknown })
      : jsonCommand(
          "glab",
          [
            "api",
            `projects/${project}/pipelines/${pipelineId}/jobs?per_page=100`,
            "--hostname",
            identity.host
          ],
          cwd,
          runner
        )
  ]);
  return {
    available: true,
    snapshot: gitlabSnapshotFromJson({
      mergeRequest: mr,
      approvals: approvals.value,
      jobs: jobs.value,
      identity,
      sourceBranch: branch
    })
  };
}

export type LiveStatusLoader = (repositoryPath: string) => Promise<LiveStatusSnapshot>;

export function createLiveStatusLoader(
  runner: CommandRunner = runCommand
): LiveStatusLoader {
  return async (repositoryPath) => {
    const root = await repositoryRootFor(repositoryPath, runner);
    if (root === null) throw new Error(`not a git worktree: ${repositoryPath}`);
    const [local, remotes] = await Promise.all([
      readSafeStatus(root, runner),
      readConfiguredRemotes(root, runner)
    ]);
    const canonical = remotes.find((remote) => remote.role === "canonical") ?? null;
    const identity: RemoteIdentity | null =
      canonical === null
        ? null
        : {
            provider: canonical.provider,
            host: canonical.host,
            path: canonical.path
          };
    let forge = { available: false, snapshot: emptyForgeSnapshot() };
    if (local.branch !== null && identity?.provider === "github") {
      forge = await githubStatus(root, identity, local.branch, runner);
    } else if (local.branch !== null && identity?.provider === "gitlab") {
      forge = await gitlabStatus(root, identity, local.branch, runner);
    }
    return {
      observedAt: new Date().toISOString(),
      repositoryPath: root,
      identity,
      local,
      changeRequest: forge.snapshot.changeRequest,
      ci: forge.snapshot.ci,
      mergeConflict: local.conflictedFiles > 0 || forge.snapshot.mergeConflict,
      reviews: forge.snapshot.reviews,
      providerAvailable: forge.available
    };
  };
}
