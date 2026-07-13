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
  /** Default GitHub org/owner for new repos under this profile, e.g. "pwrdrvr". */
  org?: string;
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
  /** Most-recent GitHub PR for this branch, if any (populated when fetched). */
  pr?: PrSummary;
};

/** A branch a worktree can switch to (a local head or a remote-tracking ref). */
export type BranchRef = {
  /** Short name — "main"/"feature/x" for locals, "origin/main" for remotes. */
  name: string;
  isRemote: boolean;
  /** The branch currently checked out in this worktree (detached ⇒ none). */
  isCurrent: boolean;
  /** Configured upstream (local branches only), e.g. "origin/main". */
  upstream?: string;
  /** ISO-8601 time of the ref's tip commit (recency sort). */
  lastCommitAt?: string;
  subject?: string;
};

/** Lifecycle of a pull request — the only status we track in the first cut. */
export type PrLifecycle = "open" | "merged" | "closed";

export type PrSummary = {
  number: number;
  url: string;
  title: string;
  state: PrLifecycle;
  isDraft: boolean;
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

/** Per-branch adornments for graph tip labels. */
export type LaneBranchInfo = {
  /** The branch's PR, when known. */
  pr?: PrSummary;
  /** The worktree this branch is checked out in, when any. */
  worktreeId?: WorktreeId;
};

/** Multi-branch lineage: a topo-ordered union log across the drawn branches. */
export type LaneGraph = {
  /** Topological order (newest first); each carries its parent hashes. */
  commits: Commit[];
  /** commit hash → local branch names tipped there (for ref labels). */
  tips: Record<string, string[]>;
  /** branch name → PR / worktree adornments for the tip chips. */
  branches: Record<string, LaneBranchInfo>;
  /** Current HEAD commit, to highlight where you are. */
  head: string;
  defaultBranch: string;
  /** Branches drawn besides the default spine. */
  shownBranches: string[];
  /** Branches that qualified for this scope before the draw cap. */
  matchedBranches: number;
  /** Branches the "active" filter hid (merged/inactive) — for the reveal hint. */
  hiddenBranches: number;
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
export type WorktreeSort = "recent" | "pinned" | "az" | "active" | "custom";

/** Lazily-filled status for a ⌘F search hit (nulls = unknown/uncached). */
export type SearchHitStatus = {
  /** ISO-8601 time of the tip commit — "how stale is this branch". */
  lastActivityAt: string | null;
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
};

export type RepoSearchHit = {
  /** "repo" = the repo itself; "worktree" = a branch match within one. */
  kind: "repo" | "worktree";
  repoId: RepoId;
  /** Repo name — or the branch name for worktree hits. */
  name: string;
  path: string;
  profileId: ProfileId;
  profileName: string;
  worktreeCount: number;
  /** The matched worktree (worktree hits only). */
  worktreeId?: WorktreeId;
  /** Owning repo's name, shown as context on worktree hits. */
  repoName?: string;
  /** The branch's PR, when known (worktree hits only). */
  pr?: PrSummary;
};
