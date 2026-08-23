// Domain types shared across processes. Modeled on the design prototype's
// data shapes (design/PwrGit.dc.html): profiles own repos, repos own
// worktrees, worktrees carry dirty/ahead/behind counts.

export type ProfileId = string;
export type RepoId = string;
export type WorktreeId = string;

/** A fixed palette for one profile window; absence inherits the app setting. */
export type ProfileThemeOverride = "dark" | "light";

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
  /** Fixed palette for this profile's window; absent means use the app setting. */
  theme?: ProfileThemeOverride;
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
  /** Cached local-branch tracking state. Absent until Git state is computed. */
  tracking?: BranchTrackingStatus;
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

/** How an initialized submodule checkout relates to the commit pinned by its
 *  parent repository. The parent gitlink is authoritative; `.gitmodules`
 *  branch configuration is only an update hint. */
export type SubmoduleRelation =
  | "at_pin"
  | "ahead_of_pin"
  | "behind_pin"
  | "diverged_from_pin"
  | "unknown";

/** Whether the submodule path can currently be inspected as a Git checkout. */
export type SubmoduleCheckoutState =
  | "checked_out"
  | "uninitialized"
  | "deinitialized"
  | "missing"
  | "not_repository";

/** A localized problem that does not invalidate the rest of the parent scan. */
export type SubmoduleIssue = {
  code:
    | "checkout_missing"
    | "checkout_uninitialized"
    | "checkout_deinitialized"
    | "checkout_not_repository"
    | "gitlink_missing"
    | "gitmodules_entry_missing"
    | "url_missing"
    | "url_changed"
    | "index_conflict"
    | "commit_unavailable"
    | "inspect_failed"
    | "scan_truncated";
  severity: "warning" | "error";
  message: string;
  /** Conservative next step phrased as guidance, never an auto-run mutation. */
  remedy?: string;
};

/** One gitlink/config/check-out record in a selected parent worktree. */
export type SubmoduleStatus = {
  /** `.gitmodules` section name, or the path when the section is absent. */
  name: string;
  /** Forward-slash path relative to the selected top-level worktree. */
  path: string;
  /** Zero for direct children, increasing for initialized nested children. */
  depth: number;
  /** Commit recorded by the parent repository's HEAD tree. */
  pinnedCommit?: string;
  /** Gitlink currently in the parent index (the next commit's pin). */
  indexCommit?: string;
  checkedOutCommit?: string;
  checkoutState: SubmoduleCheckoutState;
  relation: SubmoduleRelation;
  /** null when no checkout was available to inspect. */
  dirty: boolean | null;
  /** null when no checkout was available; true is normal after submodule update. */
  detached: boolean | null;
  checkedOutBranch?: string;
  /** Tags in the child repository that point at HEAD's pin (or a new index pin). */
  pinnedTags: string[];
  /** Values declared by `.gitmodules`; these do not replace the gitlink pin. */
  configuredUrl?: string;
  configuredBranch?: string;
  /** URL copied into the parent's local config when the submodule was initialized. */
  initializedUrl?: string;
  issues: SubmoduleIssue[];
};

/** Bounded, failure-isolated submodule inspection for one selected worktree. */
export type SubmoduleSnapshot = {
  submodules: SubmoduleStatus[];
  truncated: boolean;
  /** Parent-level parse/bounds problems not attributable to one child path. */
  issues: SubmoduleIssue[];
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

/** Hosting products PwrGit can read change-request status from. */
export type ForgeKind = "github" | "gitlab";

/**
 * What a forge can actually answer, so the UI states facts rather than guesses.
 *
 * These are properties of the *provider*, not of a login: they say what the
 * integration is able to report at all, which is why a capability being false
 * means "never ask" rather than "ask and handle the failure".
 */
export type ForgeCapabilities = {
  /** Resolves many branches per request rather than one at a time. */
  batchedBranchLookup: boolean;
  /**
   * Resolves many commit associations per request. GitLab has no batch
   * endpoint for this, so its association lookups are one request per commit
   * and callers must keep the visible set small.
   */
  batchedCommitAssociation: boolean;
  /** Reports diff size, commit count, and lifecycle timestamps. */
  changeSizeAndTimeline: boolean;
  /** Can prove the forge account behind an exact commit's Git author. */
  commitAuthorIdentity: boolean;
  /** Forking can copy only the default branch. GitLab's fork API has no
   *  equivalent, so the fork dialog hides the switch rather than accepting a
   *  control it would silently ignore. */
  forkDefaultBranchOnly: boolean;
};

/** Whether one forge is usable right now, and what it can do when it is. */
export type ForgeStatus = {
  kind: ForgeKind;
  /** The CLI PwrGit shells out to, e.g. `gh` or `glab`. */
  cli: string;
  installed: boolean;
  loggedIn: boolean;
  capabilities: ForgeCapabilities;
};

/** Lifecycle of a change request, in the vocabulary both forges collapse into. */
export type PrLifecycle = "open" | "merged" | "closed";

/**
 * One change request — a GitHub pull request or a GitLab merge request.
 *
 * "PR" is this app's neutral term for both; `forge` is what decides the wording
 * the UI shows. Everything below `isDraft` is OPTIONAL and must stay that way:
 * a row cached before those fields existed will never gain them, because a
 * change request that has already reached a terminal state stops being
 * refreshed. Readers MUST treat absence as "not known" and render nothing —
 * never as zero, which is a different and much stronger claim.
 */
export type PrSummary = {
  number: number;
  url: string;
  title: string;
  state: PrLifecycle;
  isDraft: boolean;
  /** Which forge issued this number; decides PR vs MR wording. */
  forge?: ForgeKind;
  /** Forge host — a number is only unique within one instance. */
  host?: string;
  /** Namespace path, e.g. `pwrdrvr/PwrGit` or `group/sub/project`. */
  repoPath?: string;
  /** Branch holding the changes. */
  headRefName?: string;
  /** Branch the changes are proposed into. */
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitCount?: number;
  /** Epoch milliseconds. Immutable, so age stays exact without re-polling. */
  createdAt?: number;
  /** Epoch milliseconds; set only on the matching terminal state. */
  mergedAt?: number;
  closedAt?: number;
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
   * lenses (Focused/Behind/Stale) answer a question, so a manual order there
   * would fight the answer.
   */
  order?: number;
  worktrees: Worktree[];
  /** Forge identity for the repo's `origin`, when one has been read. Absent
   *  means "not looked up yet", which the marks render distinctly from
   *  `visibility: "unknown"` ("looked up, forge would not say"). */
  identity?: RepoIdentity;
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

/** A remote's forge, or `other` when no provider claims its host — which is a
 *  fact the identity marks render, not a failure. `ForgeKind` is the set of
 *  forges PwrGit can actually talk to; this is that set plus "cannot say". */
export type ForgeHost = ForgeKind | "other";

/** Who can see a repository. GitHub only has `internal` on Enterprise; GitLab
 *  has it on every tier. `unknown` is load-bearing rather than a null stand-in:
 *  it is what an unauthenticated, unreachable, or unsupported forge answers,
 *  and rendering it as "public" would be a lie about where code can go. */
export type RepoVisibility = "public" | "private" | "internal" | "unknown";

/** One end of a fork relationship. */
export type ForgeRepoRef = {
  nameWithOwner: string;
  /** Browser URL — what "open on GitHub/GitLab" navigates to. */
  url: string;
};

/** What the repo identity marks render from. Stored per repo so the sidebar
 *  paints on launch without waiting for the network; refreshed best-effort. */
export type RepoIdentity = {
  host: ForgeHost;
  /** The remote's hostname — `github.com`, `gitlab.example.com`. Rendered for
   *  self-hosted instances, where a bare "GITLAB" would misstate where the
   *  code actually lives. */
  hostname: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  visibility: RepoVisibility;
  /** Present only when this repo is a fork — its immediate parent. */
  parent?: ForgeRepoRef;
  /** Root of the fork network, when that is not the immediate parent. A fork
   *  of a fork is the case that makes `upstream` ambiguous. */
  root?: ForgeRepoRef;
  /** ISO timestamp of the last successful read from the forge. */
  fetchedAt?: string;
};

/** Ways the clone dialog can hand a repository to the local machine. `cli`
 *  defers to the forge's own CLI (and its credential helper) — it was
 *  `gh_cli` when GitHub was the only forge, and is host-labelled now. */
export type CloneProtocol = "ssh" | "https" | "cli";

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

/** Forge repository metadata used by the clone and fork autocompletes. */
export type CloneRepository = {
  name: string;
  owner: string;
  nameWithOwner: string;
  description?: string;
  /** Replaced the original `isPrivate` boolean: a boolean cannot express
   *  GitLab's third tier, nor "we could not find out". */
  visibility: RepoVisibility;
  host: ForgeHost;
  hostname: string;
  /** Immediate parent when this repository is a fork; absent on a source. */
  parent?: ForgeRepoRef;
  /** Fork-network root, when it differs from `parent`. */
  root?: ForgeRepoRef;
  sshUrl: string;
  httpsUrl: string;
  updatedAt?: string;
  /** Canonical filesystem source for a plain local `git clone`. Absent for
   * forge repositories. */
  localPath?: string;
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

/** An account a fork can be created in. */
export type ForgeOwner = {
  login: string;
  kind: "user" | "organization";
  /** Which forge the account lives on. Always a real forge — an account on
   *  `other` is not something a fork can be created in. */
  host: ForgeKind;
};

/**
 * What the clone and fork dialogs need to *open*, and nothing more.
 *
 * Deliberately carries no repositories. It once did — the catalog listed every
 * owner's repositories up front, which cost one forge round trip per account
 * before the user had typed anything (~13s on a profile with sixteen owners).
 * Repositories now arrive from `repo:searchCloneSources`, on debounced input.
 */
export type CloneCatalog = {
  /** Accounts the search is scoped to, across every forge in use. Read from
   *  what is already indexed locally, so opening the dialog costs no network. */
  owners: ForgeOwner[];
  /** One entry per forge PwrGit knows how to talk to, so a dialog can say
   *  which CLI is missing rather than assuming GitHub. */
  forges: ForgeStatus[];
};

/** Live progress for one fork. The clone phases are shared verbatim with
 *  `CloneProgress`; the three forge-side phases are new and unmetered, which
 *  is why they are named steps rather than a stalled percentage. */
export type ForkProgress = {
  phase:
    | "starting"
    | "creating"
    | "awaiting_fork"
    | CloneProgress["phase"]
    | "adding_upstream";
  percent: number | null;
  completedObjects?: number;
  totalObjects?: number;
  bytesReceived?: string;
  transferRate?: string;
};

/** What `repo:checkForkSource` answers: the source, plus everything the dialog
 *  needs to decide what the button should say before anything is created. */
export type ForkPreflight = {
  source: CloneRepository;
  /** The fork that would be created, or the one that already exists. */
  target: { owner: string; name: string; nameWithOwner: string };
  /** An existing fork of this source already owned by the target account. */
  existing?: CloneRepository;
  /** Candidate `upstream` remotes, best answer first. More than one entry
   *  means the source is itself a fork and the choice is genuinely open. */
  upstreamChoices: ForgeRepoRef[];
  /** Set when forking cannot proceed — the reason, already phrased for a
   *  human. The dialog renders it instead of enabling the button. */
  blocked?: {
    code:
      | "self_owned"
      | "forking_disabled"
      | "cli_missing"
      | "login_required"
      | "unsupported_host";
    message: string;
  };
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

/**
 * How many entries per section survive into the renderer. Reading them costs
 * git almost nothing (`-uall` over 20k untracked files measured ~40ms against
 * ~25ms collapsed), but the rail paints a row apiece and that is superlinear:
 * ~25ms of raw DOM for 1k rows, ~540ms for 20k — on every refresh, so every
 * stage click. Past this many files the answer is a .gitignore rule, not a
 * longer list, so the list is capped and says so.
 */
export const CHANGE_LIST_LIMIT = 1000;

export type ChangeSet = {
  staged: FileChange[];
  unstaged: FileChange[];
  /**
   * Set only when `CHANGE_LIST_LIMIT` bit. The totals are the real counts, so
   * the UI can say what it is not showing; `largestUntrackedFolder` names the
   * directory that contributed the most rows — the one worth ignoring.
   */
  truncated?: {
    staged: number;
    unstaged: number;
    largestUntrackedFolder: { dir: string; count: number } | null;
  };
};

/** Git operation whose sequencer/index state is still present in a worktree. */
export type ConflictOperationKind =
  | "merge"
  | "rebase"
  | "am"
  | "cherry-pick"
  | "revert";

/** One side of an unmerged index entry. Git calls stages 2/3 ours/theirs. */
export type ConflictStageInfo = {
  stage: 1 | 2 | 3;
  oid: string;
  mode: string;
};

/** Honest classification from the stages Git actually exposes for one path. */
export type ConflictPathKind =
  | "both_modified"
  | "both_added"
  | "delete_or_rename_by_ours"
  | "delete_or_rename_by_theirs"
  | "added_by_ours"
  | "added_by_theirs"
  | "complex";

export type ConflictWorkingTreeInfo = {
  kind: "file" | "symlink" | "directory" | "other";
  size: number;
};

/** A path that still has at least one unmerged index stage. */
export type ConflictedPath = {
  path: string;
  kind: ConflictPathKind;
  /** Stage 1, absent for add/add and other no-base conflicts. */
  base: ConflictStageInfo | null;
  /** Stage 2. Absence is meaningful: accepting ours resolves as a deletion. */
  ours: ConflictStageInfo | null;
  /** Stage 3. Absence is meaningful: accepting theirs resolves as a deletion. */
  theirs: ConflictStageInfo | null;
  /** Current checkout entry, if one exists. This may contain conflict markers. */
  workingTree: ConflictWorkingTreeInfo | null;
};

export type ConflictOperation = {
  kind: ConflictOperationKind;
  label: string;
  /** Rebase step progress, when Git exposes both counters. */
  progress?: { current: number; total: number };
};

/** Fresh operation + index truth for the selected worktree. */
export type ConflictState = {
  operation: ConflictOperation | null;
  conflicts: ConflictedPath[];
};

/** Lazy content payload. Binary and large blobs are never decoded as text. */
export type ConflictContent =
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "too-large"; limit: number }
  | { kind: "unavailable"; reason: string };

export type ConflictBlobPreview = {
  size: number;
  content: ConflictContent;
};

export type ConflictStagePreview = ConflictStageInfo & ConflictBlobPreview;

export type ConflictWorkingTreePreview = ConflictWorkingTreeInfo &
  ConflictBlobPreview & {
    /** Guards an inline save against overwriting a newer external edit. */
    contentHash: string;
    /** Only regular, complete UTF-8 text files can be edited inline. */
    editable: boolean;
  };

/** Lazy inspection of one still-conflicted path. Missing stages stay null. */
export type ConflictInspection = {
  path: string;
  kind: ConflictPathKind;
  base: ConflictStagePreview | null;
  ours: ConflictStagePreview | null;
  theirs: ConflictStagePreview | null;
  workingTree: ConflictWorkingTreePreview | null;
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

/** Profile-wide repository synchronization without destructive recovery. */
export type BulkSyncMode = "fetch" | "soft-pull";

export type BulkSyncRemoteResult = {
  remote: string;
  outcome: "fetched" | "skipped" | "failed" | "cancelled";
  reason?:
    | "skip_fetch_all"
    | "authentication"
    | "fetch_failed"
    | "cancelled";
  message?: string;
};

export type BulkSyncWorktreeResult = {
  worktreeId: WorktreeId;
  branch: string;
  path: string;
  outcome: "updated" | "up_to_date" | "skipped" | "failed" | "cancelled";
  reason?:
    | "dirty"
    | "conflicts"
    | "detached_head"
    | "no_head"
    | "no_upstream"
    | "in_progress"
    | "diverged"
    | "ahead"
    | "authentication"
    | "fetch_failed"
    | "upstream_not_fetched"
    | "unsafe_state"
    | "merge_failed"
    | "cancelled";
  message?: string;
  /** Exact commit ids before and after a successful fast-forward. */
  beforeHead?: string;
  afterHead?: string;
};

export type BulkSyncRepoResult = {
  repoId: RepoId;
  name: string;
  path: string;
  outcome: "success" | "partial" | "skipped" | "failed" | "cancelled";
  remotes: BulkSyncRemoteResult[];
  worktrees: BulkSyncWorktreeResult[];
  message?: string;
};

export type BulkSyncCounts = {
  repos: {
    success: number;
    partial: number;
    skipped: number;
    failed: number;
    cancelled: number;
  };
  remotes: {
    fetched: number;
    skipped: number;
    failed: number;
    cancelled: number;
  };
  worktrees: {
    updated: number;
    upToDate: number;
    skipped: number;
    failed: number;
    cancelled: number;
  };
};

export type BulkSyncSummary = {
  operationId: string;
  mode: BulkSyncMode;
  cancelled: boolean;
  startedAt: string;
  finishedAt: string;
  counts: BulkSyncCounts;
  results: BulkSyncRepoResult[];
};

/** Incremental progress for a long-running profile-wide sync command. */
export type BulkSyncProgress = {
  operationId: string;
  mode: BulkSyncMode;
  phase: "starting" | "repo_started" | "repo_completed";
  totalRepos: number;
  completedRepos: number;
  repoId?: RepoId;
  repoName?: string;
  result?: BulkSyncRepoResult;
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
  /** That worktree's path on disk, for menus that offer to copy it. */
  worktreePath?: string;
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
  /** Branches drawn besides the default spine. This is the branch *selection*
   *  — the toolbar's "N of M" counts it, so supplementary refs stay out. */
  shownBranches: string[];
  /** Remote-tracking refs drawn on top of `shownBranches` because a drawn
   *  branch (or this worktree's own) is behind them. Their commits are fetched
   *  but unapplied, so the graph dashes them, the way the trunk's
   *  `defaultRefTips` are drawn above local main. */
  upstreamRefs: string[];
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

export type Lens = "Focused" | "Pinned" | "Behind" | "Stale" | "All";
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
