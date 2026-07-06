// Domain types shared across processes. Modeled on the design prototype's
// data shapes (design/PwrGit.dc.html): profiles own repos, repos own
// worktrees, worktrees carry dirty/ahead/behind counts.

export type ProfileId = string;
export type RepoId = string;
export type WorktreeId = string;

export type Profile = {
  id: ProfileId;
  name: string;
  /** Default commit email for this profile (one shared GitHub identity). */
  email: string;
  /**
   * Optional git author name override for commits made under this profile.
   * When absent, the repo/global `user.name` is used.
   */
  authorName?: string;
  /** 1-2 character monogram for the avatar tile. */
  mono: string;
  /** Free-form label, e.g. "Work", "Personal org", "Side". */
  kind?: string;
  /** Root folders scanned to discover this profile's repos. */
  roots: string[];
  /** ISO-8601 timestamp of the last time this profile was active. */
  lastUsedAt?: string;
};

export type Worktree = {
  id: WorktreeId;
  repoId: RepoId;
  branch: string;
  path: string;
  /** Count of changed files in the working tree (staged + unstaged). */
  dirty: number;
  /** Commits ahead of upstream. */
  ahead: number;
  /** Commits behind upstream. */
  behind: number;
  /** Commits the repo's default branch is ahead of this worktree (staleness).
   *  0 when the branch shares no history with the default (see divergedFromDefault). */
  behindDefault: number;
  /** This worktree's branch is fully merged into the default branch. */
  mergedIntoDefault: boolean;
  /** No common ancestor with the default branch (rewritten/orphaned history). */
  divergedFromDefault: boolean;
  /** This worktree is on the repo's default branch (never flagged stale). */
  isDefaultBranch: boolean;
  /** ISO-8601 time of the worktree branch's last commit (staleness signal). */
  lastActivityAt?: string;
  pinned: boolean;
  /** Persisted drag-order index within the repo (U14); absent until reordered. */
  order?: number;
  /** True for the repo's primary checkout (not a linked worktree). */
  isPrimary: boolean;
};

export type Repo = {
  id: RepoId;
  name: string;
  path: string;
  profileId: ProfileId;
  pinned: boolean;
  worktrees: Worktree[];
};

/** Porcelain XY status letters, collapsed to a single display code. */
export type FileStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export type FileChange = {
  path: string;
  status: FileStatus;
  staged: boolean;
};

export type ChangeSet = {
  staged: FileChange[];
  unstaged: FileChange[];
};

export type Commit = {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601 commit time. */
  committedAt: string;
  isMerge: boolean;
};

/** Cached, watcher-invalidated per-worktree sync/dirty snapshot (U8). */
export type WorktreeState = {
  worktreeId: WorktreeId;
  branch: string;
  head: string;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  dirty: number;
  behindDefault: number;
  mergedIntoDefault: boolean;
  divergedFromDefault: boolean;
  isDefaultBranch: boolean;
  /** ISO-8601 time of the branch's last commit. */
  lastActivityAt?: string;
  /** ISO-8601 time the snapshot was computed. */
  updatedAt: string;
};

/** A page of commit history plus the branch's divergence point. */
export type GraphLog = {
  commits: Commit[];
  /** merge-base of HEAD and the default branch (the branch root). */
  branchRoot: string | null;
  defaultBranch: string;
};

export type RebaseStep = {
  action: "pick" | "squash";
  shortHash: string;
  subject: string;
};

export type RebasePlan = {
  op: "squash" | "reorder";
  steps: RebaseStep[];
  summary: string;
  /** False when the selection can't be rebased (e.g. not the most-recent run). */
  valid: boolean;
  reason?: string;
};

export type RebaseCommitRef = { hash: string; subject: string };

export type AgentStatus = {
  available: boolean;
  home?: string;
  reason?: string;
};

export type Lens = "Recent" | "Pinned" | "Behind" | "Stale" | "All";
export type WorktreeSort = "pinned" | "az" | "active" | "custom";

export type RepoSearchHit = {
  repoId: RepoId;
  name: string;
  path: string;
  profileId: ProfileId;
  profileName: string;
  worktreeCount: number;
};
