/** Repository maintenance is explicitly scoped; all profiles is opt-in. */
export type MaintenanceScope = {
  profileId: string;
  allProfiles?: boolean;
  /** Narrow the scope to these repositories — the refs browser's "Clean up
   *  finished branches…" reviews the one repository it was opened on. */
  repoIds?: string[];
};
export type GarbageCollectionMode = "standard" | "keep-largest" | "aggressive";
export type MaintenanceRepo = {
  id: string;
  name: string;
  path: string;
  profileId: string;
  profileName: string;
};

/** The age guard's choices, in days. Anything else crossing IPC is refused. */
export const BRANCH_CLEANUP_KEEP_DAYS = [1, 3, 7, 14, 30, 90] as const;
export type BranchCleanupKeepDays = (typeof BRANCH_CLEANUP_KEEP_DAYS)[number];

export function isBranchCleanupKeepDays(
  value: unknown
): value is BranchCleanupKeepDays {
  return BRANCH_CLEANUP_KEEP_DAYS.includes(value as BranchCleanupKeepDays);
}

/** How the finished-branch review decides. */
export type BranchCleanupOptions = {
  /**
   * Count a merged pull request as proof, for squash and rebase merges whose
   * commits never reach HEAD by ancestry. Only when the local tip IS the PR's
   * final head (or an ancestor of it) — so nothing added after merging is lost.
   */
  prProof: boolean;
  /** Keep branches touched within this many days; null turns the guard off. */
  keepDays: BranchCleanupKeepDays | null;
};

/** The review's rules when a caller names none: PR proof on, a week's guard. */
export const DEFAULT_BRANCH_CLEANUP_OPTIONS: BranchCleanupOptions = {
  prProof: true,
  keepDays: 7
};

/** Why a branch is safe to delete. Decides the delete path, too. */
export type StaleBranchEvidence =
  /** Its tip is in HEAD — ordinary `git branch -d` agrees. */
  | "ancestry"
  /** Its tip is a merged PR's head — `branch -d` refuses a squash merge, so
   *  deletion is a compare-and-swap on the reviewed tip instead. */
  | "pr";

export type StaleBranchPr = {
  number: number;
  url: string;
  mergedAt?: number;
};

/** A gone branch the review offers to delete. */
export type StaleBranch = {
  repoId: string;
  branch: string;
  expectedHead: string;
  upstream: string;
  evidence: StaleBranchEvidence;
  pr?: StaleBranchPr;
  /** Epoch ms: the newest of the tip's commit date and the last checkout or
   *  reset of the branch that the reflog remembers. */
  touchedAt?: number;
};

/** Why a gone branch was not offered. */
export type KeptBranchReason =
  /** Checked out in a worktree; deleting it would orphan a checkout. */
  | "worktree"
  /** A merged PR exists, but the local tip holds commits it did not. */
  | "unmerged_commits"
  /** Its PR was closed without merging. */
  | "pr_closed"
  /** Its PR is still open. */
  | "pr_open"
  /** No merged PR, and not in HEAD — nothing proves the commits exist
   *  elsewhere. Includes a merged PR whose head commit is unknown. */
  | "no_proof"
  /** Proven by a merged PR, but PR proof is switched off. */
  | "pr_proof_off"
  /** Proven, but touched inside the age guard. */
  | "recent";

export type KeptBranch = {
  branch: string;
  reason: KeptBranchReason;
  /** The line the review shows, e.g. "2 local commits not in #398". */
  detail: string;
  pr?: StaleBranchPr;
  touchedAt?: number;
};

export type MaintenanceAction =
  | {
      kind: "gc";
      mode: GarbageCollectionMode;
      /** Count finished branches after collecting, with these rules, so the
       *  receipt can offer the clean-up. Absent: no count. */
      branchOptions?: BranchCleanupOptions;
    }
  | { kind: "scan-branches"; options?: BranchCleanupOptions }
  | {
      kind: "delete-branches";
      branches: StaleBranch[];
      options?: BranchCleanupOptions;
    };

/** One branch the delete action handled; `head` is what a restore recreates. */
export type DeletedBranchResult = {
  branch: string;
  head: string;
  deleted: boolean;
  message: string;
};

export type MaintenanceRepoResult = {
  repo: MaintenanceRepo;
  outcome: "success" | "partial" | "skipped" | "failed" | "cancelled";
  message: string;
  beforeBytes?: number;
  afterBytes?: number;
  candidates?: StaleBranch[];
  /** Gone branches the review did not offer, each with its reason. */
  kept?: KeptBranch[];
  branches?: DeletedBranchResult[];
};
export type MaintenanceSummary = {
  operationId: string;
  startedAt: string;
  finishedAt: string;
  cancelled: boolean;
  results: MaintenanceRepoResult[];
};
export type MaintenanceProgress = {
  operationId: string;
  profileId: string;
  phase: "starting" | "repo_started" | "repo_progress" | "repo_completed";
  repos?: MaintenanceRepo[];
  repo?: MaintenanceRepo;
  detail?: string;
  result?: MaintenanceRepoResult;
};
