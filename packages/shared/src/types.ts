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
  /** Resolved default branch used for behindDefault, e.g. "main". */
  defaultBranch: string;
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

export type BranchTrackingStatus =
  | "up_to_date"
  | "ahead"
  | "behind"
  | "diverged"
  | "unpublished"
  | "upstream_missing";

/** A local `refs/heads/*` branch in the repository-wide branch browser. */
export type LocalBranchSummary = {
  name: string;
  fullName: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  tracking: BranchTrackingStatus;
  /** Worktrees currently holding this branch. Empty means it can be switched to. */
  checkedOutWorktreeIds: WorktreeId[];
  lastCommitAt?: string;
  subject?: string;
};

/** A fetched snapshot of one branch on a named remote. */
export type RemoteBranchSummary = {
  /** Branch name relative to its remote, e.g. `main`, not `origin/main`. */
  name: string;
  /** Display-qualified name, e.g. `origin/main`. */
  qualifiedName: string;
  fullName: string;
  head: string;
  lastCommitAt?: string;
  subject?: string;
};

export type RemoteResetMode = "soft" | "hard";

/** Exact local checkout and fetched remote-tracking ref reviewed before reset. */
export type RemoteResetSnapshot = {
  branch: string;
  /** Full object name of the checked-out local tip shown to the user. */
  head: string;
  /** Fully qualified fetched ref, e.g. `refs/remotes/origin/main`. */
  remoteRef: string;
  /** Full object name of the fetched remote-tracking tip shown to the user. */
  remoteHead: string;
};

export type RemoteSummary = {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  /** Branch name relative to the remote, when its symbolic HEAD is known. */
  defaultBranch?: string;
  skipFetchAll: boolean;
  /**
   * The newest `REMOTE_BRANCH_PREVIEW` branches by committer date — enough for
   * the sidebar disclosure, and deliberately NOT the whole set. A fetched fork
   * network runs to thousands of remote-tracking refs (openclaw: 4,466), which
   * is megabytes of IPC to hand a surface that renders six rows. Page the rest
   * through `repo:remoteBranches`.
   */
  previewBranches: RemoteBranchSummary[];
  /** Total branches on this remote, of which `previewBranches` is a prefix. */
  branchCount: number;
};

/** One page of `repo:remoteBranches`, newest commit first. */
export type RemoteBranchPage = {
  rows: RemoteBranchSummary[];
  /** Matches for the query across the whole remote, not just this page. */
  total: number;
};

/** Reviewed migration from a GitHub HTTPS fetch URL to its SSH equivalent. */
export type SshRemoteRecovery = {
  remote: string;
  httpsUrl: string;
  sshUrl: string;
  /** With no explicit pushurl, changing the fetch URL changes push too. */
  pushUrlWillAlsoChange: boolean;
};

/** Repository-wide refs and configured remote endpoints. */
export type RepoRefs = {
  branches: LocalBranchSummary[];
  remotes: RemoteSummary[];
};

export type PushRefRelation =
  | "create"
  | "equal"
  | "fast_forward"
  | "destination_ahead"
  | "diverged";

/** Reviewed source/destination snapshot used by the guarded multi-remote push. */
export type PushRefPlan = {
  sourceRef: string;
  sourceLabel: string;
  sourceHead: string;
  destinationRemote: string;
  destinationBranch: string;
  destinationHead?: string;
  relation: PushRefRelation;
};

export type PushRefResult = {
  destinationRemote: string;
  destinationBranch: string;
  outcome: "pushed" | "up_to_date" | "failed";
  message?: string;
};

/** Coarse, user-facing milestones during a pull. Git does not expose a stable
 * percentage for checkout or filter work, so phases stay honest without
 * guessing at completion. */
export type PullProgressPhase =
  | "fetch"
  | "prepare"
  | "fast_forward"
  | "reapply"
  | "refresh";

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
  /**
   * Persisted drag-order index within the profile; absent until the user
   * arranges the list by hand. Only the Pinned lens honors it — the computed
   * lenses (Recent/Behind/Stale) answer a question, so a manual order there
   * would fight the answer.
   */
  order?: number;
  worktrees: Worktree[];
};

/** Effective Git LFS readiness for one checked-out worktree. Repositories that
 * do not declare tracked `filter=lfs` attributes skip the more expensive
 * executable/configuration probes. */
export type GitLfsStatus =
  | {
      required: false;
    }
  | {
      required: true;
      /** PwrGit's Git runtime can invoke `git lfs`. */
      installed: boolean;
      /** Effective repo/global Git config contains the standard LFS filters. */
      configured: boolean;
      /** Full `git lfs version` output when the executable was available. */
      version?: string;
    };

/** Ways the clone dialog can hand a GitHub repository to the local machine. */
export type CloneProtocol = "ssh" | "https" | "gh_cli";

/** Live progress reported by Git while a repository is being cloned. */
export type CloneProgress = {
  phase:
    | "starting"
    | "counting"
    | "compressing"
    | "receiving"
    | "resolving"
    | "checking_out"
    | "indexing";
  /** Phase-local completion reported by Git; null for unmetered work. */
  percent: number | null;
  completedObjects?: number;
  totalObjects?: number;
  /** Git's human-readable transferred byte count, such as `12.4 MiB`. */
  bytesReceived?: string;
  /** Git's human-readable transfer rate, such as `3.1 MiB/s`. */
  transferRate?: string;
};

/** GitHub repository metadata used by the clone autocomplete. */
export type CloneRepository = {
  name: string;
  owner: string;
  nameWithOwner: string;
  description?: string;
  isPrivate: boolean;
  sshUrl: string;
  httpsUrl: string;
  updatedAt?: string;
  /** Existing indexed checkouts, if this repository is already on the machine. */
  localPaths: string[];
};

/** A registered root or a nested prefix directory inferred from local repos. */
export type CloneDestination = {
  /** Absolute directory that will contain the new repository folder. */
  path: string;
  /** Registered profile root this suggestion belongs to. */
  root: string;
  /** Root-relative path. Empty means the registered root itself. */
  relativePath: string;
  /** Repositories currently nested beneath this directory. */
  repoCount: number;
  /** Explicit use by the clone flow, newest first when present. */
  lastUsedAt?: string;
};

export type CloneCatalog = {
  owners: string[];
  repositories: CloneRepository[];
  github: { installed: boolean; loggedIn: boolean };
  /** Owner catalogs that could not be loaded; other results remain usable. */
  warning?: string;
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
  /** Resolved default branch used for behindDefault, e.g. "main". */
  defaultBranch: string;
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
  /** Full object name, used to correlate range-diff output. */
  hash: string;
  shortHash: string;
  subject: string;
  additions: number;
  deletions: number;
};

export type DivergenceCommitRelation =
  | "equivalent"
  | "changed"
  | "local-only"
  | "upstream-only";

/** One range-diff row, ordered newest-first for direct display. */
export type DivergenceCommitAlignment = {
  local: DivergenceCommit | null;
  upstream: DivergenceCommit | null;
  relation: DivergenceCommitRelation;
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
  /** Patch-aware correspondence between the two unique commit ranges. */
  alignedCommits: DivergenceCommitAlignment[];
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

export type RebaseOperation = "squash" | "reorder";

export type RebasePlan = {
  op: RebaseOperation;
  steps: RebaseStep[];
  summary: string;
  /** False when the selection can't be rebased (e.g. not the most-recent run). */
  valid: boolean;
  reason?: string;
};

export type RebaseCommitRef = { hash: string; subject: string };

export type RebaseCheckResult =
  | {
      status: "clean";
      approvalToken: string;
      sourceHead: string;
      message: string;
    }
  | { status: "snag"; code: string; message: string };

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

/**
 * Worktree-less branch action carried between profile-bound windows: a fetched
 * remote-only ref becomes a new tracking branch (hence its start point), while
 * a local branch already exists and is simply checked out.
 */
export type BranchReveal =
  | { kind: "remote"; name: string; fullName: string }
  | { kind: "local"; name: string };

export type RepoSearchHit = {
  /** Repo itself, checked-out worktree, or a branch with no worktree —
   *  fetched remote-only, or local with nothing checked out on it. */
  kind: "repo" | "worktree" | "remote_branch" | "local_branch";
  repoId: RepoId;
  /** Repo name, checked-out branch, or worktree-less branch name. */
  name: string;
  path: string;
  profileId: ProfileId;
  profileName: string;
  worktreeCount: number;
  /** Pin state of the repo — or of the worktree for worktree hits. */
  pinned: boolean;
  /** The matched worktree (worktree hits only). */
  worktreeId?: WorktreeId;
  /** Fully-qualified fetched ref (remote-branch hits only). */
  remoteRef?: string;
  /** Configured remote that owns the fetched ref (remote-branch hits only). */
  remoteName?: string;
  /** Owning repo's name, shown as context on branch hits. */
  repoName?: string;
  /** The branch's PR, when known (worktree hits only). */
  pr?: PrSummary;
};
