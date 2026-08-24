export type ForgeProvider = "github" | "gitlab" | "other";

export type RemoteIdentity = {
  provider: ForgeProvider;
  host: string;
  path: string;
};

export type RemoteSummary = RemoteIdentity & {
  name: string;
  role: "canonical" | "upstream" | "other";
};

export type SafeStatusSummary = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  conflictedFiles: number;
  changedFiles: number;
  clean: boolean;
  operation: "merge" | "rebase" | "cherry_pick" | "revert" | null;
};

export type WorktreeSummary = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  primary: boolean;
  status: SafeStatusSummary | null;
};

export type RepositoryInfo = {
  requestedPath: string;
  repositoryPath: string;
  currentBranch: string | null;
  defaultBranch: string | null;
  canonicalRemote: RemoteSummary | null;
  remotes: RemoteSummary[];
  fork: {
    isFork: true | null;
    upstream: RemoteIdentity | null;
    evidence: "upstream_remote" | "not_determinable";
  };
  worktreeCount: number;
  worktreesTruncated: boolean;
  worktrees: WorktreeSummary[];
  status: SafeStatusSummary;
};

export type CiState =
  | "success"
  | "failure_with_running"
  | "terminal_failure"
  | "running"
  | "pending"
  | "none"
  | "unknown";

export type CiSummary = {
  state: CiState;
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  pending: number;
  skipped: number;
};

export type ReviewSummary = {
  id: string;
  actor: string | null;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "unknown";
  submittedAt: string | null;
};

export type ReviewState = {
  decision: "approved" | "changes_requested" | "review_required" | "none" | "unknown";
  blocking: boolean;
  blockingReason:
    | "changes_requested"
    | "approval_required"
    | "blocking_discussion"
    | null;
  latest: ReviewSummary[];
};

export type ChangeRequestState = {
  provider: "github" | "gitlab";
  host: string;
  repository: string;
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  sourceBranch: string;
  targetBranch: string | null;
};

export type LiveStatusSnapshot = {
  observedAt: string;
  repositoryPath: string;
  identity: RemoteIdentity | null;
  local: SafeStatusSummary;
  changeRequest: ChangeRequestState | null;
  ci: CiSummary;
  mergeConflict: boolean;
  reviews: ReviewState;
  providerAvailable: boolean;
};

export type LiveEventKind =
  | "snapshot"
  | "repository.status"
  | "ci.status"
  | "merge.conflict"
  | "review.submitted"
  | "review.blocking"
  | "change_request.state";

export type LiveStatusEvent = {
  protocol: "pwrgit.events/v1";
  id: string;
  sequence: number;
  emittedAt: string;
  subscriptionId: string;
  repositoryPath: string;
  kind: LiveEventKind;
  snapshot: LiveStatusSnapshot;
  previous?: LiveStatusSnapshot;
  review?: ReviewSummary;
};
