import { git, runCommand, type CommandRunner } from "./command.js";
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
  RemoteSummary,
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
const GITHUB_PR_CANDIDATE_LIMIT = 20;
const GITLAB_MR_CANDIDATE_LIMIT = 20;
const GITLAB_JOB_PAGE_SIZE = 100;
const MAX_GITLAB_JOB_PAGES = 5;

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

const UNKNOWN_REVIEWS: ReviewState = {
  decision: "unknown",
  blocking: false,
  blockingReason: null,
  latest: []
};

function unknownCiSummary(): CiSummary {
  return {
    state: "unknown",
    total: 0,
    succeeded: 0,
    failed: 0,
    running: 0,
    pending: 0,
    skipped: 0
  };
}

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
  approvalsAvailable?: boolean;
  jobs?: unknown;
  jobsAvailable?: boolean;
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
  const approvalsAvailable = input.approvalsAvailable !== false;
  const approvals = approvalsAvailable ? record(input.approvals) : null;
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
  const decision: ReviewState["decision"] = !approvalsAvailable
    ? "unknown"
    : approvalRequired
      ? "review_required"
      : latest.length > 0
        ? "approved"
        : "none";
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const statuses = jobs.flatMap((entry) => {
    const job = record(entry);
    const status = string(job?.status)?.toLowerCase();
    if (status === null || status === undefined) return [];
    if (
      boolean(job?.allow_failure) === true &&
      (FAILURE.has(status) || status === "manual")
    ) {
      return ["skipped"];
    }
    return [status];
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
    ci: input.jobsAvailable === false ? unknownCiSummary() : summarizeChecks(statuses),
    mergeConflict: conflict,
    reviews:
      !approvalsAvailable && !blockingDiscussion
        ? UNKNOWN_REVIEWS
        : {
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

type ForgeStatusResult = { available: boolean; snapshot: ForgeSnapshot };

function identityFromRemote(remote: RemoteSummary): RemoteIdentity {
  return { provider: remote.provider, host: remote.host, path: remote.path };
}

function sameRemoteIdentity(left: RemoteIdentity, right: RemoteIdentity): boolean {
  return (
    left.provider === right.provider &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

export function forgeTargetIdentities(
  remotes: readonly RemoteSummary[],
  source: RemoteIdentity
): RemoteIdentity[] {
  const upstream = remotes.find((remote) => remote.role === "upstream");
  const candidates = [
    ...(upstream === undefined ? [] : [identityFromRemote(upstream)]),
    source
  ];
  const targets: RemoteIdentity[] = [];
  for (const candidate of candidates) {
    if (
      candidate.provider !== source.provider ||
      candidate.host.toLowerCase() !== source.host.toLowerCase() ||
      targets.some((target) => sameRemoteIdentity(target, candidate))
    ) {
      continue;
    }
    targets.push(candidate);
  }
  return targets;
}

function githubHeadIdentity(value: unknown): string | null {
  const pullRequest = record(value);
  const repository = record(pullRequest?.headRepository);
  const direct = string(repository?.nameWithOwner);
  if (direct !== null) return direct;
  const owner = record(pullRequest?.headRepositoryOwner);
  const login = string(owner?.login);
  const name = string(repository?.name);
  return login === null || name === null ? null : `${login}/${name}`;
}

function githubPullRequestMatches(
  value: unknown,
  source: RemoteIdentity,
  branch: string,
  headOid: string
): boolean {
  const pullRequest = record(value);
  return (
    string(pullRequest?.headRefName) === branch &&
    string(pullRequest?.headRefOid)?.toLowerCase() === headOid.toLowerCase() &&
    githubHeadIdentity(value)?.toLowerCase() === source.path.toLowerCase()
  );
}

export async function githubStatus(
  cwd: string,
  source: RemoteIdentity,
  targets: readonly RemoteIdentity[],
  branch: string,
  headOid: string,
  runner: CommandRunner
): Promise<ForgeStatusResult> {
  let incomplete = false;
  for (const target of targets) {
    const repository =
      target.host === "github.com" ? target.path : `${target.host}/${target.path}`;
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
        String(GITHUB_PR_CANDIDATE_LIMIT),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName,mergeStateStatus,reviewDecision,latestReviews,statusCheckRollup"
      ],
      cwd,
      runner
    );
    if (!response.available || !Array.isArray(response.value)) {
      incomplete = true;
      continue;
    }
    const pullRequest = response.value.find((candidate) =>
      githubPullRequestMatches(candidate, source, branch, headOid)
    );
    if (pullRequest !== undefined) {
      return {
        available: true,
        snapshot: githubSnapshotFromJson(pullRequest, target, branch)
      };
    }
  }
  return { available: !incomplete, snapshot: emptyForgeSnapshot() };
}

type JsonCommandResult = Awaited<ReturnType<typeof jsonCommand>>;

export async function loadGitlabPipelineJobs(
  cwd: string,
  project: string,
  pipelineId: number,
  hostname: string,
  runner: CommandRunner
): Promise<JsonCommandResult> {
  const jobs: unknown[] = [];
  for (let page = 1; page <= MAX_GITLAB_JOB_PAGES; page += 1) {
    const response = await jsonCommand(
      "glab",
      [
        "api",
        `projects/${project}/pipelines/${pipelineId}/jobs?per_page=${GITLAB_JOB_PAGE_SIZE}&page=${page}`,
        "--hostname",
        hostname
      ],
      cwd,
      runner
    );
    if (!response.available || !Array.isArray(response.value)) {
      return { available: false, value: null };
    }
    jobs.push(...response.value);
    if (response.value.length < GITLAB_JOB_PAGE_SIZE) {
      return { available: true, value: jobs };
    }
  }
  return { available: false, value: null };
}

function gitlabMergeRequestMatches(
  value: unknown,
  sourceProjectId: number,
  branch: string,
  headOid: string
): boolean {
  const mergeRequest = record(value);
  return (
    number(mergeRequest?.source_project_id) === sourceProjectId &&
    string(mergeRequest?.source_branch) === branch &&
    string(mergeRequest?.sha)?.toLowerCase() === headOid.toLowerCase()
  );
}

export async function gitlabStatus(
  cwd: string,
  source: RemoteIdentity,
  targets: readonly RemoteIdentity[],
  branch: string,
  headOid: string,
  runner: CommandRunner
): Promise<ForgeStatusResult> {
  const sourceProject = await jsonCommand(
    "glab",
    [
      "api",
      `projects/${encodeURIComponent(source.path)}`,
      "--hostname",
      source.host
    ],
    cwd,
    runner
  );
  const sourceProjectId = number(record(sourceProject.value)?.id);
  if (!sourceProject.available || sourceProjectId === null) {
    return { available: false, snapshot: emptyForgeSnapshot() };
  }

  let incomplete = false;
  for (const target of targets) {
    const project = encodeURIComponent(target.path);
    const mergeRequests = await jsonCommand(
      "glab",
      [
        "api",
        `projects/${project}/merge_requests?scope=all&source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&sort=desc&per_page=${GITLAB_MR_CANDIDATE_LIMIT}`,
        "--hostname",
        target.host
      ],
      cwd,
      runner
    );
    if (!mergeRequests.available || !Array.isArray(mergeRequests.value)) {
      incomplete = true;
      continue;
    }
    const listed = mergeRequests.value.find((candidate) =>
      gitlabMergeRequestMatches(candidate, sourceProjectId, branch, headOid)
    );
    const iid = number(record(listed)?.iid);
    if (iid === null) continue;

    const detail = await jsonCommand(
      "glab",
      [
        "api",
        `projects/${project}/merge_requests/${iid}?with_merge_status_recheck=true`,
        "--hostname",
        target.host
      ],
      cwd,
      runner
    );
    if (
      !detail.available ||
      !gitlabMergeRequestMatches(detail.value, sourceProjectId, branch, headOid)
    ) {
      incomplete = true;
      continue;
    }
    const pipeline = record(record(detail.value)?.head_pipeline);
    const pipelineId = number(pipeline?.id);
    const pipelineProjectId = number(pipeline?.project_id);
    const [approvals, jobs] = await Promise.all([
      jsonCommand(
        "glab",
        [
          "api",
          `projects/${project}/merge_requests/${iid}/approvals`,
          "--hostname",
          target.host
        ],
        cwd,
        runner
      ),
      pipelineId === null
        ? Promise.resolve({ available: true, value: [] as unknown })
        : loadGitlabPipelineJobs(
            cwd,
            pipelineProjectId === null ? project : String(pipelineProjectId),
            pipelineId,
            target.host,
            runner
          )
    ]);
    return {
      available: approvals.available && jobs.available,
      snapshot: gitlabSnapshotFromJson({
        mergeRequest: detail.value,
        approvals: approvals.value,
        approvalsAvailable: approvals.available,
        jobs: jobs.value,
        jobsAvailable: jobs.available,
        identity: target,
        sourceBranch: branch
      })
    };
  }
  return { available: !incomplete, snapshot: emptyForgeSnapshot() };
}

async function readHeadOid(
  cwd: string,
  runner: CommandRunner
): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--verify", "HEAD"], runner);
  if (result.exitCode !== 0) return null;
  const oid = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
}

export type LiveStatusLoader = (repositoryPath: string) => Promise<LiveStatusSnapshot>;

export function createLiveStatusLoader(
  runner: CommandRunner = runCommand
): LiveStatusLoader {
  return async (repositoryPath) => {
    const root = await repositoryRootFor(repositoryPath, runner);
    if (root === null) throw new Error(`not a git worktree: ${repositoryPath}`);
    const [local, remotes, headOid] = await Promise.all([
      readSafeStatus(root, runner),
      readConfiguredRemotes(root, runner),
      readHeadOid(root, runner)
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
    const targets = identity === null ? [] : forgeTargetIdentities(remotes, identity);
    if (
      local.branch !== null &&
      headOid !== null &&
      identity?.provider === "github"
    ) {
      forge = await githubStatus(
        root,
        identity,
        targets,
        local.branch,
        headOid,
        runner
      );
    } else if (
      local.branch !== null &&
      headOid !== null &&
      identity?.provider === "gitlab"
    ) {
      forge = await gitlabStatus(
        root,
        identity,
        targets,
        local.branch,
        headOid,
        runner
      );
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
