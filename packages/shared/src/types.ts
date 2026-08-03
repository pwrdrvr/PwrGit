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

/** Result of reconciling one indexed repo with `git worktree list`. Both
 *  outcomes are successes: a repo row whose path turns out to be a linked
 *  worktree of another repo is dropped on purpose, and that is a completed
 *  refresh, not a failed one. */
export type RepoWorktreeRefresh =
  | {
      outcome: "reconciled";
      repo: Repo;
      added: number;
      removed: number;
      /** Existing paths whose branch or primary-checkout identity changed. */
      updated: number;
    }
  | {
      /** The row pointed at a linked worktree rather than a repo, so it was
       *  removed from the index. */
      outcome: "deindexed";
      profileId: ProfileId;
      /** The repo that actually owns that worktree, straight from
       *  `git worktree list`. It is NOT necessarily indexed itself — say where
       *  the worktree belongs rather than claiming it is already on screen. */
      ownerPath: string;
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

/** One file touched by a commit (rail's commit-scoped file list). */
export type CommitFileChange = {
  path: string;
  status: FileStatus;
};

/** Summed insertions and deletions introduced by one commit. */
export type CommitStats = {
  additions: number;
  deletions: number;
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

/** GitHub account presentation fields proven for an exact Git commit author. */
export type GitHubCommitAuthorIdentity = {
  login: string;
  /**
   * Renderer-safe, versioned `pwrgit-avatar://thumbnail/...` URL backed by
   * PwrGit's on-disk thumbnail cache. The GitHub source URL and filesystem
   * path deliberately never cross IPC; Chromium may retain this local image.
   */
  avatarUrl?: string;
};

/** Thumbnail work still pending for an otherwise proven GitHub identity. */
export type GitHubCommitAuthorAvatarCacheStatus = {
  cacheState: "stale" | "miss";
  refreshState: "in-flight" | "backing-off";
  /** Epoch milliseconds of the thumbnail's last successful disk/network refresh. */
  refreshedAt?: number;
  /** Epoch milliseconds before a later hover should retry a failed thumbnail refresh. */
  nextRetryAt?: number;
};

/** Immediate, presentation-neutral result of a commit-author identity lookup. */
export type GitHubCommitAuthorIdentityLookup = {
  /** Present only after an exact commit proof has verified the mapping. */
  identity?: GitHubCommitAuthorIdentity;
  cacheState: "fresh" | "stale" | "miss";
  refreshState: "idle" | "in-flight" | "backing-off" | "not-eligible";
  /** Epoch milliseconds of the last successful exact-commit proof, when known. */
  refreshedAt?: number;
  /** Epoch milliseconds before which another hover should not retry a failure. */
  nextRetryAt?: number;
  /** Present only while a proven avatar's local thumbnail needs later hover work. */
  avatarCache?: GitHubCommitAuthorAvatarCacheStatus;
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

/** A commit that exists on only one side of a diverged tracked branch. */
export type DivergenceCommit = {
  shortHash: string;
  subject: string;
};

/**
 * Fresh comparison of a checked-out branch and its configured upstream after
 * a fast-forward-only pull cannot proceed. This deliberately reports facts,
 * rather than prescribing one recovery path.
 */
export type RemoteDivergence = {
  branch: string;
  /** Full object name of the checked-out local tip shown to the user. */
  head: string;
  upstream: string;
  /** Full object name of the upstream tip shown to the user. */
  upstreamHead: string;
  workingTreeClean: boolean;
  localCommits: DivergenceCommit[];
  upstreamCommits: DivergenceCommit[];
  /**
   * Both sides have the same number of unique commits and their subject lines
   * match in history order. This is consistent with a remote rebase/force-push,
   * but is intentionally not a recommendation to discard local history.
   */
  matchingCommitSubjects: boolean;
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
  /** commit hash → remote-tracking refs tipped there (e.g. "origin/main"). */
  remoteTips: Record<string, string[]>;
  /** branch name → PR / worktree adornments for the tip chips. */
  branches: Record<string, LaneBranchInfo>;
  /** Current HEAD commit, to highlight where you are. */
  head: string;
  /** Commits reachable from this worktree's HEAD but not its default ref.
   *  This is per-worktree (unlike the cached lane graph) and lets consumers
   *  distinguish a branch's own commits from shared/base history. */
  headOnlyCommits: string[];
  defaultBranch: string;
  /** The concrete ref used as the default-branch comparison point, usually
   *  `origin/main` when a remote default is configured. */
  defaultRef: string;
  /** Tips of each remote's copy of the default branch (origin/main,
   *  upstream/main, …) — the trunk is drawn through them so remote-ahead
   *  history renders as a dashed spine ending at the remote ref's chip. */
  defaultRefTips: string[];
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
  /** Pin state of the repo — or of the worktree for worktree hits. */
  pinned: boolean;
  /** The matched worktree (worktree hits only). */
  worktreeId?: WorktreeId;
  /** Owning repo's name, shown as context on worktree hits. */
  repoName?: string;
  /** The branch's PR, when known (worktree hits only). */
  pr?: PrSummary;
};
