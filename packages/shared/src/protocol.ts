// Typed Commands + Events registry — the single source of truth for the
// command-bus across main / preload / renderer.
//
// Adding a command: declare it in `Commands`, then register a handler in
// apps/desktop/src/main. The renderer's `dispatch(name, req)` picks up the
// new command's request/response types for free.
//
// This registry grows per milestone. Milestone A defines the foundation
// (ping) plus the profile + repo-discovery surface the sidebar needs; later
// milestones extend `Commands`/`Events` with worktree-state, changes, remote,
// graph, and rebase entries.

import type {
  BranchRef,
  CloneCatalog,
  CloneDestination,
  CloneProgress,
  CloneProtocol,
  CloneRepository,
  ForgeHost,
  ForkPreflight,
  ForkProgress,
  RepoIdentity,
  PushRefPlan,
  PushRefResult,
  ChangeSet,
  Commit,
  CommitFileChange,
  CommitStats,
  GitHubCommitAuthorIdentityLookup,
  GraphLog,
  GitLfsStatus,
  LaneGraph,
  ForgeStatus,
  PrSummary,
  Profile,
  ProfileId,
  PullProgressPhase,
  RebaseCommitRef,
  RebaseCheckResult,
  RebaseOperation,
  RebasePlan,
  RemoteBranchPage,
  RemoteDivergence,
  BranchReveal,
  RemoteResetMode,
  RemoteResetSnapshot,
  Repo,
  RepoRefs,
  RepoSearchHit,
  RepoWorktreeRefresh,
  SearchHitStatus,
  SshRemoteRecovery,
  WorktreeState
} from "./types";
import type { ImagePreview, ImageRevision } from "./image";

export type ProfileList = {
  activeProfileId: ProfileId | null;
  profiles: Profile[];
};

/** One line in the main-process app log (ring-buffered, streamed live). */
export type LogEntry = {
  /** Monotonic id — lets the Logs window dedupe snapshot vs live stream. */
  sequence: number;
  timestamp: number;
  level: "error" | "warn" | "info" | "debug";
  scope: string;
  /** Pre-formatted `[ts] [level] (scope) text` line. */
  line: string;
};

export type LogSnapshot = {
  entries: LogEntry[];
  /** Older entries were dropped from the ring buffer. */
  truncated: boolean;
  /** On-disk log file, when file logging is active. */
  logFilePath: string | null;
};

/** A first-party or bundled notice document displayed inside the desktop app. */
export type AppDocumentKind = "license" | "third-party-notices";

export type AppDocument = {
  kind: AppDocumentKind;
  title: string;
  content: string;
};

export type CreateProfileRequest = {
  name: string;
  email: string;
  authorName?: string;
  mono?: string;
  kind?: string;
  org?: string;
  roots?: string[];
};

export type UpdateProfileRequest = {
  profileId: ProfileId;
  name?: string;
  email?: string;
  authorName?: string;
  org?: string;
};

// App settings (Settings window). Experimental + diagnostics sections are
// stored sparsely in settings.json; reads return a fully-defaulted snapshot.

export const HOT_CPU_START_DELAYS_MS = [0, 5_000, 10_000] as const;
export type HotCpuStartDelayMs = (typeof HOT_CPU_START_DELAYS_MS)[number];
export function isHotCpuStartDelayMs(value: number): value is HotCpuStartDelayMs {
  return (HOT_CPU_START_DELAYS_MS as readonly number[]).includes(value);
}

export const HOT_CPU_TRIGGER_MODES = ["spike", "sustained", "slowburn"] as const;
export type HotCpuTriggerMode = (typeof HOT_CPU_TRIGGER_MODES)[number];
export function isHotCpuTriggerMode(value: string): value is HotCpuTriggerMode {
  return (HOT_CPU_TRIGGER_MODES as readonly string[]).includes(value);
}

/** Renderer heap snapshots captured per hot-CPU profile; hard cap. */
export const HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX = 3;

// Diagnostics tuning defaults, shared so the Settings UI copy and the main
// process resolvers can never drift. Env vars (PWRGIT_*) override at runtime.
export const HEAP_MONITOR_TUNING = {
  intervalMs: 5_000,
  deltaThresholdBytes: 100 * 1024 * 1024,
  maxSnapshots: 5
} as const;

export const HOT_CPU_TUNING = {
  intervalMs: 2_000,
  thresholdPercent: 50,
  slowburnThresholdPercent: 15,
  profileDurationMs: 15_000
} as const;

/** Diagnostics forced on by PWRGIT_* env vars — shown in the UI so a switch
 *  reading "Off" can't hide an env-armed profiler. */
export type DiagnosticsEnvOverrides = {
  heapMonitorForcedOn: boolean;
  hotCpuProfilingForcedOn: boolean;
  startupCpuProfilingForcedOn: boolean;
};

/**
 * Sidebar text-size notches. "md" is the tuned default and, like the theme,
 * carries no attribute — only non-default notches stamp `data-sidebar-text`
 * on <html>, where `tokens.css` picks them up.
 */
export const SIDEBAR_TEXT_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
export type SidebarTextSize = (typeof SIDEBAR_TEXT_SIZES)[number];

export function isSidebarTextSize(value: unknown): value is SidebarTextSize {
  return (
    typeof value === "string" &&
    (SIDEBAR_TEXT_SIZES as readonly string[]).includes(value)
  );
}

/** Row density. "comfortable" is the default and carries no attribute. */
export const SIDEBAR_DENSITIES = ["comfortable", "compact"] as const;
export type SidebarDensity = (typeof SIDEBAR_DENSITIES)[number];

export function isSidebarDensity(value: unknown): value is SidebarDensity {
  return (
    typeof value === "string" &&
    (SIDEBAR_DENSITIES as readonly string[]).includes(value)
  );
}

/**
 * Where a branch created from a commit gets checked out. "none" leaves the
 * working copies alone (just the ref), "new-worktree" adds one under the
 * worktree root, "here" switches the worktree the branch was created from.
 */
export const BRANCH_CHECKOUT_TARGETS = ["none", "new-worktree", "here"] as const;
export type BranchCheckoutTarget = (typeof BRANCH_CHECKOUT_TARGETS)[number];
export const BRANCH_CHECKOUT_TARGET_DEFAULT: BranchCheckoutTarget = "none";

export function isBranchCheckoutTarget(
  value: unknown
): value is BranchCheckoutTarget {
  return (
    typeof value === "string" &&
    (BRANCH_CHECKOUT_TARGETS as readonly string[]).includes(value)
  );
}

/**
 * Remote branches carried inline on `repo:refs`, per remote. The sidebar
 * disclosure renders six rows, so shipping more buys nothing — and shipping
 * all of them cost 1.5 MB of JSON on a fetched fork network.
 */
export const REMOTE_BRANCH_PREVIEW = 6;

/** Default page size for `repo:remoteBranches`. */
export const REMOTE_BRANCH_PAGE_SIZE = 50;

/** Upper bound a renderer cannot talk its way past, so one page stays one page. */
export const REMOTE_BRANCH_PAGE_MAX = 200;

/** Latest is smoke-checked; Prerelease is newer and may not install. */
export const UPDATE_CHANNELS = ["latest", "prerelease"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export const UPDATE_CHANNEL_DEFAULT: UpdateChannel = "latest";

/** Stable is the 1.0 train; Beta follows main. */
export const UPDATE_TRAINS = ["stable", "beta"] as const;
export type UpdateTrain = (typeof UPDATE_TRAINS)[number];
export const UPDATE_TRAIN_DEFAULT: UpdateTrain = "stable";

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return (
    typeof value === "string" &&
    (UPDATE_CHANNELS as readonly string[]).includes(value)
  );
}

export function isUpdateTrain(value: unknown): value is UpdateTrain {
  return (
    typeof value === "string" &&
    (UPDATE_TRAINS as readonly string[]).includes(value)
  );
}

export type UpdatesSettings = {
  channel: UpdateChannel;
  train: UpdateTrain;
};

// Last 1.0 core that used `-beta.N` as the Stable prerelease line. Builds
// at this core stay on Stable so a website Beta download cannot be confused
// with `v1.0.0-beta.50`.
const LEGACY_STABLE_BETA_CORE: [number, number, number] = [1, 0, 0];

function parseUpdateVersion(
  version: string
): { core: [number, number, number]; pre: string[] } | undefined {
  const trimmed = version.trim().replace(/^v/i, "");
  const match = trimmed.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return undefined;
  const [, maj, min, patch, pre] = match;
  return {
    core: [Number(maj), Number(min), Number(patch)],
    pre: pre ? pre.split(".") : []
  };
}

/**
 * Map a desktop app version onto the Settings update train/track.
 * Used only when both `updates.train` and `updates.channel` are unset so a
 * GitHub or website download of Beta/Prerelease follows that feed. A
 * pre-train config that only set `channel` stays on Stable.
 */
export function inferUpdateSelection(version: string): UpdatesSettings {
  const parsed = parseUpdateVersion(version);
  if (!parsed || parsed.pre.length === 0) {
    return {
      channel: UPDATE_CHANNEL_DEFAULT,
      train: UPDATE_TRAIN_DEFAULT
    };
  }
  const id = parsed.pre[0];
  if (id === "alpha") {
    return { channel: "prerelease", train: "beta" };
  }
  if (id === "prerelease" || id === "rc") {
    return { channel: "prerelease", train: UPDATE_TRAIN_DEFAULT };
  }
  if (id === "beta") {
    const isLegacyStableBeta =
      parsed.core[0] === LEGACY_STABLE_BETA_CORE[0] &&
      parsed.core[1] === LEGACY_STABLE_BETA_CORE[1] &&
      parsed.core[2] === LEGACY_STABLE_BETA_CORE[2];
    if (isLegacyStableBeta) {
      return {
        channel: UPDATE_CHANNEL_DEFAULT,
        train: UPDATE_TRAIN_DEFAULT
      };
    }
    return { channel: "latest", train: "beta" };
  }
  return { channel: "prerelease", train: UPDATE_TRAIN_DEFAULT };
}

/** Resolve stored keys, inferring from the app version only when both are absent. */
export function resolveUpdateSelection(
  stored: Partial<UpdatesSettings> | undefined,
  appVersion: string
): UpdatesSettings {
  if (stored?.channel === undefined && stored?.train === undefined) {
    return inferUpdateSelection(appVersion);
  }
  return {
    channel: stored.channel ?? UPDATE_CHANNEL_DEFAULT,
    train: stored.train ?? UPDATE_TRAIN_DEFAULT
  };
}

export type AppUpdateCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "downloaded"; version: string }
  | { status: "available"; version: string };

export type AppUpdateStatus =
  | { status: "idle" }
  | { status: "skipped"; reason: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

export type AppUpdateInstallResult =
  | { status: "restarting" }
  | { status: "error"; message: string };

export type AppUpdateReleaseInfo = {
  version?: string;
  name?: string;
  url?: string;
  publishedAt?: string;
  unavailableReason?: string;
};

export type AppUpdateReleaseSlotVersions = {
  latest: AppUpdateReleaseInfo;
  prerelease: AppUpdateReleaseInfo;
};

export type AppUpdateReleaseVersions = {
  stable: AppUpdateReleaseSlotVersions;
  beta: AppUpdateReleaseSlotVersions;
  fetchedAt: number;
};

export type GeneralSettings = {
  /** Expose Reload, Force Reload, and Developer Tools in the View menu. */
  developerMode: boolean;
  /** Sidebar name/branch type scale (`--sidebar-title-size`). */
  sidebarTextSize: SidebarTextSize;
  /** Sidebar row density — trims row padding and list gaps. */
  sidebarDensity: SidebarDensity;
};

export type ExperimentalSettings = {
  /** Lineage graph opens scoped to all branches instead of active ones. */
  lineageAllBranches: boolean;
};

export type DiagnosticsSettings = {
  /** Sample main + renderer heaps; auto-snapshot on growth spikes. */
  heapMonitorEnabled: boolean;
  /** Arm the hot renderer CPU profiler (captures when CPU stays hot). */
  hotCpuProfilingEnabled: boolean;
  hotCpuProfilingStartDelayMs: HotCpuStartDelayMs;
  hotCpuProfilingTriggerMode: HotCpuTriggerMode;
  /** Also capture renderer heap snapshots around each hot-CPU profile. */
  hotCpuProfilingCaptureHeapSnapshot: boolean;
  /** 1..HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX snapshots per session. */
  hotCpuProfilingHeapSnapshotLimit: number;
  /** Profile app startup (main + first window) on every launch while on. */
  startupCpuProfilingEnabled: boolean;
};

export const GENERAL_DEFAULTS: GeneralSettings = {
  developerMode: false,
  sidebarTextSize: "md",
  sidebarDensity: "comfortable"
};

export const EXPERIMENTAL_DEFAULTS: ExperimentalSettings = {
  lineageAllBranches: false
};

export const DIAGNOSTICS_DEFAULTS: DiagnosticsSettings = {
  heapMonitorEnabled: false,
  hotCpuProfilingEnabled: false,
  hotCpuProfilingStartDelayMs: 0,
  hotCpuProfilingTriggerMode: "sustained",
  hotCpuProfilingCaptureHeapSnapshot: false,
  hotCpuProfilingHeapSnapshotLimit: 2,
  startupCpuProfilingEnabled: false
};

export type AppSettingsSnapshot = {
  general: GeneralSettings;
  experimental: ExperimentalSettings;
  diagnostics: DiagnosticsSettings;
  updates: UpdatesSettings;
  diagnosticsEnv: DiagnosticsEnvOverrides;
  /** Directory diagnostics sessions (profiles, snapshots) are written to. */
  diagnosticsOutputRoot: string;
};

export type AppSettingsPatch = {
  general?: Partial<GeneralSettings>;
  experimental?: Partial<ExperimentalSettings>;
  diagnostics?: Partial<DiagnosticsSettings>;
  updates?: Partial<UpdatesSettings>;
};

export interface Commands {
  /** Liveness probe — proves the command-bus round-trip end to end. */
  ping: { req: void; res: string };

  // Profiles (U5). One window per profile: "switching" means opening (or
  // focusing) that profile's window, never repointing the current one.
  "profile:list": { req: void; res: ProfileList };
  "profile:switch": { req: { profileId: ProfileId }; res: ProfileList };
  /** Open (or focus) the window bound to a profile; optionally reveal a repo
   *  (and a specific worktree) there once it's up — cross-profile ⌘F picks. */
  "profile:openWindow": {
    req: {
      profileId: ProfileId;
      revealRepoId?: string;
      revealWorktreeId?: string;
      revealBranch?: BranchReveal;
    };
    res: null;
  };
  /** A window asks, once on boot, whether a reveal is queued for it. */
  "window:consumeReveal": {
    req: { profileId: ProfileId };
    res: {
      repoId: string | null;
      worktreeId: string | null;
      branch: BranchReveal | null;
    };
  };
  "profile:create": { req: CreateProfileRequest; res: Profile };
  "profile:update": { req: UpdateProfileRequest; res: Profile };
  /** Replace a profile's scan roots wholesale, then rescan. */
  "profile:setRoots": {
    req: { profileId: ProfileId; roots: string[] };
    res: Repo[];
  };

  // Repos & discovery (U6)
  "repo:list": { req: { profileId?: ProfileId }; res: Repo[] };
  "repo:rescan": { req: { profileId?: ProfileId }; res: Repo[] };
  /** Reconcile one repo with Git, discovering external worktree changes. */
  "repo:refreshWorktrees": {
    req: { repoId: string };
    res: RepoWorktreeRefresh;
  };
  "repo:add": { req: { profileId: ProfileId; path: string }; res: Repo };
  /** Forge repositories shown by the clone and fork dialogs. */
  "repo:cloneCatalog": { req: { profileId: ProfileId }; res: CloneCatalog };
  /** Clone destinations, loaded in a fast roots/MRU pass before nested prefixes. */
  "repo:cloneDestinations": {
    req: { profileId: ProfileId; includeNested: boolean };
    res: CloneDestination[];
  };
  /** Verify an exact `owner/name` that was not in the loaded owner catalogs. */
  "repo:checkCloneSource": {
    req: { profileId: ProfileId; nameWithOwner: string; host?: ForgeHost };
    res: CloneRepository;
  };
  /** Clone into a registered profile root/prefix and index the new checkout. */
  "repo:clone": {
    req: {
      operationId: string;
      profileId: ProfileId;
      nameWithOwner: string;
      protocol: CloneProtocol;
      parentPath: string;
      /** Which forge to clone from. Defaults to GitHub for older callers. */
      host?: ForgeHost;
      /** The forge's hostname, so a self-hosted instance clones from itself. */
      hostname?: string;
    };
    res: Repo;
  };
  /**
   * Everything the fork dialog needs before it creates anything: the source,
   * where the fork would land, whether it is already there, the candidate
   * `upstream` remotes, and any reason forking is blocked.
   */
  "repo:forkPreflight": {
    req: {
      profileId: ProfileId;
      source: string;
      host: ForgeHost;
      /** Account to fork into; defaults to the signed-in user. */
      targetOwner?: string;
    };
    res: ForkPreflight;
  };
  /** Create a fork, check it out, wire `upstream`, and index the checkout. */
  "repo:fork": {
    req: {
      operationId: string;
      profileId: ProfileId;
      source: string;
      host: ForgeHost;
      hostname: string;
      targetOwner: string;
      targetName: string;
      protocol: CloneProtocol;
      parentPath: string;
      defaultBranchOnly: boolean;
      /** `owner/name` for the `upstream` remote, or null to add none. */
      upstream: string | null;
    };
    res: Repo;
  };
  /** Re-read forge identity (visibility, fork lineage) for a profile's repos.
   *  Answers the changed rows; the rest of the tree is left alone. */
  "repo:refreshIdentities": {
    req: { profileId: ProfileId; force?: boolean };
    res: { changed: number };
  };
  "repo:search": { req: { query: string }; res: RepoSearchHit[] };
  /** Lazy per-hit status for ⌘F results (cached worktree_state when present;
   *  else one cheap `git log -1` for tip age). Called one hit at a time — the
   *  renderer's cancelable fill queue owns batching/concurrency. */
  "search:status": {
    req: { repoId: string; worktreeId?: string };
    res: SearchHitStatus;
  };
  "repo:setPin": { req: { repoId: string; pinned: boolean }; res: null };
  "repo:computeState": { req: { repoId: string }; res: null };
  /** Whether a checkout declares Git LFS rules and can apply them locally. */
  "repo:getGitLfsStatus": {
    req: { repoId: string; worktreeId: string };
    res: GitLfsStatus;
  };

  // GitHub PR status. Repo expansion uses the bulk cached lookup; focused
  // worktrees and deliberate hover prefetches target one branch instead.
  "pr:refresh": {
    req: {
      repoId: string;
      branches?: string[];
      trigger?: "scheduled" | "user";
      force?: boolean;
    };
    res: null;
  };
  /**
   * Atomically replace one graph's visible-commit monitoring reason. The main
   * process polls only the union of active reasons; an empty list removes it.
   */
  "pr:replaceVisibleCommits": {
    req: {
      repoId: string;
      worktreeId: string;
      /** Stable for one mounted graph, so parallel windows remain cumulative. */
      monitorId: string;
      commitHashes: string[];
    };
    res: Record<string, PrSummary | null>;
  };
  /** Deliberate hover refresh for one or more commits without monitoring them. */
  "pr:refreshCommits": {
    req: {
      repoId: string;
      commitHashes: string[];
      trigger?: "scheduled" | "user";
    };
    res: Record<string, PrSummary | null>;
  };
  /** Replace this window's durable selected-worktree PR monitoring reason. */
  "pr:replaceWorktreeMonitor": {
    req: {
      monitorId: string;
      target?: { repoId: string; worktreeId: string; branch: string };
    };
    res: null;
  };
  /**
   * Which forges are usable right now, and what each can do.
   *
   * Answered entirely from main's cached probe: the renderer must never shell a
   * forge CLI or call a vendor API itself. Under React StrictMode every effect
   * runs twice, so a renderer-side probe becomes a duplicated subprocess per
   * mount; here a repeated request is just a cache read.
   */
  "forge:status": {
    req: void;
    res: { forges: ForgeStatus[] };
  };
  /**
   * Return immediately and start any eligible identity verification in the
   * background. `cacheOnly` warms an existing exact or author-account proof
   * without GitHub lookup on a miss. Results arrive via the targeted event
   * after the worktree's GitHub origin has been validated.
   */
  "github:commitAuthorIdentity": {
    req: {
      worktreeId: string;
      commitHash: string;
      authorName: string;
      authorEmail: string;
      /**
       * Warm only already-proven exact or author-account data. A cache-only
       * request never calls GitHub for a miss; a normal hover request may.
       */
      cacheOnly?: boolean;
    };
    res: GitHubCommitAuthorIdentityLookup;
  };
  /**
   * Hydrate every locally proven commit/author identity before graph rows are
   * interactive. This is local-cache-only on a miss; stale proofs may publish
   * targeted refresh events later.
   */
  "github:hydrateCommitAuthorIdentities": {
    req: {
      worktreeId: string;
      commits: Array<{
        commitHash: string;
        authorName: string;
        authorEmail: string;
      }>;
    };
    res: Record<string, GitHubCommitAuthorIdentityLookup>;
  };
  "worktree:setPin": { req: { worktreeId: string; pinned: boolean }; res: null };

  // Worktree state (U8)
  "worktree:getState": {
    req: { worktreeId: string };
    res: WorktreeState | null;
  };
  "worktree:activate": { req: { worktreeId: string }; res: null };

  // Worktree lifecycle (U14)
  "worktree:create": {
    req: {
      repoId: string;
      branch: string;
      newBranch: boolean;
      /** Optional remote/local ref used as the starting point of a new branch. */
      startPoint?: string;
    };
    res: {
      /**
       * The worktree just indexed for `branch`, so the caller can select it.
       * Null only if the post-create refresh failed to list it.
       */
      worktreeId: string | null;
    };
  };
  /** Resolve the path `worktree:create` would use, for a pre-create preview. */
  "worktree:pathPreview": {
    req: { repoId: string; branch: string };
    res: { path: string };
  };
  "worktree:removeMany": {
    req: { worktreeIds: string[]; force?: boolean };
    res: {
      removed: string[];
      /** Skipped because they have uncommitted changes (retry with force). */
      dirty: string[];
      /** Other failures (e.g. primary worktree, not found). */
      failed: { id: string; message: string }[];
    };
  };
  "worktree:setOrder": {
    req: { repoId: string; orderedWorktreeIds: string[] };
    res: null;
  };
  /** Persist the user's hand-arranged repo order within a profile. */
  "repo:setOrder": {
    req: { profileId: string; orderedRepoIds: string[] };
    res: null;
  };

  // Branch switching — list local + remote branches, check one out in place
  "branch:list": { req: { worktreeId: string }; res: BranchRef[] };
  /**
   * Local branch names only — the "is this name taken?" question, without the
   * per-ref metadata (or the thousands of remote-tracking refs) `branch:list`
   * carries across IPC to answer it.
   */
  "branch:localNames": { req: { worktreeId: string }; res: string[] };
  "branch:switch": { req: { worktreeId: string; branch: string }; res: null };
  /**
   * Create a branch at an arbitrary commit and optionally check it out. The
   * worktree supplies the git directory the branch is written to, and is also
   * the checkout target for `"here"`.
   */
  "branch:create": {
    req: {
      worktreeId: string;
      branch: string;
      /** Commit the new branch points at. */
      startPoint: string;
      checkout: BranchCheckoutTarget;
    };
    res: {
      /** Worktree now holding the branch — added or switched — else null. */
      checkedOutWorktreeId: string | null;
      /** Path of a worktree added for the branch, else null. */
      worktreePath: string | null;
    };
  };
  /** Repository-wide local branches and configured remote-tracking refs. */
  "repo:refs": { req: { repoId: string }; res: RepoRefs };
  /**
   * One page of a remote's branches, newest commit first. `repo:refs` carries
   * only a preview per remote; every surface that browses or picks from the
   * full set pages through here so a fork network's thousands of
   * remote-tracking refs never cross IPC in one response.
   */
  "repo:remoteBranches": {
    req: {
      repoId: string;
      /** Restrict to one remote; omitted searches across all of them. */
      remote?: string;
      /** Case-insensitive substring over qualified name and commit subject. */
      query?: string;
      offset?: number;
      limit?: number;
    };
    res: RemoteBranchPage;
  };

  // Remotes (U9 / U13)
  "remote:fetch": { req: { worktreeId: string }; res: null };
  /** Fetch one named remote, or every non-skipped remote when omitted. */
  "remote:fetchRepo": {
    req: { repoId: string; remote?: string };
    res: null;
  };
  "remote:add": {
    req: { repoId: string; name: string; fetchUrl: string; pushUrl?: string };
    res: null;
  };
  "remote:update": {
    req: {
      repoId: string;
      originalName: string;
      name: string;
      fetchUrl: string;
      pushUrl?: string;
    };
    res: null;
  };
  /** Inspect the checked-out branch for a GitHub HTTPS upstream. */
  "remote:inspectSshRecovery": {
    req: { worktreeId: string };
    res: SshRemoteRecovery | null;
  };
  /** Test the reviewed SSH URL without fetching or changing local refs. */
  "remote:testSshRecovery": {
    req: { worktreeId: string; recovery: SshRemoteRecovery };
    res: null;
  };
  /** Revalidate and replace only the reviewed remote's fetch URL. */
  "remote:applySshRecovery": {
    req: { worktreeId: string; recovery: SshRemoteRecovery };
    res: null;
  };
  "remote:remove": { req: { repoId: string; remote: string }; res: null };
  /** Fetch current tips and classify a source ref against push destinations. */
  "remote:planPushRefs": {
    req: {
      repoId: string;
      sourceRef: string;
      destinations: { remote: string; branch: string }[];
    };
    res: PushRefPlan[];
  };
  /** Execute only still-safe create/fast-forward plans; each target is isolated. */
  "remote:pushRefs": {
    req: { repoId: string; plans: PushRefPlan[] };
    res: PushRefResult[];
  };
  "remote:pull": {
    req: { worktreeId: string };
    res: {
      fastForwarded: boolean;
      /** Local work was auto-stashed to let the fast-forward through. */
      stashed: boolean;
      /** Reapplying the stashed work after the pull hit conflicts. */
      reappliedWithConflicts: boolean;
    };
  };
  "remote:push": { req: { worktreeId: string }; res: null };
  /** Fresh branch/upstream comparison after a non-fast-forward pull. */
  "remote:inspectDivergence": {
    req: { worktreeId: string };
    res: RemoteDivergence;
  };
  /** Move the inspected clean local branch to the exact upstream tip shown. */
  "remote:resetToUpstream": {
    req: {
      worktreeId: string;
      branch: string;
      head: string;
      upstreamHead: string;
    };
    res: null;
  };
  /** Resolve a checked-out local branch and one fetched remote ref for review. */
  "remote:inspectReset": {
    req: { worktreeId: string; remoteRef: string };
    res: RemoteResetSnapshot;
  };
  /** Reset only the still-current checkout/ref pair from the reviewed snapshot. */
  "remote:resetToRemote": {
    req: RemoteResetSnapshot & {
      worktreeId: string;
      mode: RemoteResetMode;
    };
    res: null;
  };
  /** Replay the inspected clean local commits on the exact upstream tip shown. */
  "remote:rebaseOntoUpstream": {
    req: {
      worktreeId: string;
      branch: string;
      head: string;
      upstreamHead: string;
    };
    res: null;
  };

  // Lineage graph (U10)
  "graph:log": {
    req: { worktreeId: string; limit?: number };
    res: GraphLog;
  };
  /** Multi-lane lineage across active (or all) branches. The branch set + log
   *  is cached per repo; `force` recomputes it (else only HEAD is re-resolved). */
  "graph:lanes": {
    req: {
      worktreeId: string;
      scope: "active" | "all";
      limit?: number;
      force?: boolean;
    };
    res: LaneGraph;
  };

  // Local rebase planning, isolated checking, and guarded apply (U15 / U16)
  "rebase:draft": {
    req: {
      worktreeId: string;
      commits: RebaseCommitRef[];
      op: RebaseOperation;
    };
    res: RebasePlan;
  };
  "rebase:check": {
    req: {
      worktreeId: string;
      commits: RebaseCommitRef[];
      op: RebaseOperation;
    };
    res: RebaseCheckResult;
  };
  "rebase:apply": {
    req: {
      worktreeId: string;
      commits: RebaseCommitRef[];
      op: RebaseOperation;
      approvalToken: string;
    };
    res: null;
  };

  // Changes (U11 / U12)
  "changes:list": { req: { worktreeId: string }; res: ChangeSet };
  /** Stage the named paths. A folder row sends every file it lists, so the
   *  command stages exactly what the user saw. */
  "changes:stage": { req: { worktreeId: string; paths: string[] }; res: null };
  "changes:unstage": {
    req: { worktreeId: string; paths: string[] };
    res: null;
  };
  /** Discard uncommitted changes to the named paths (revert to HEAD, or delete
   *  if new). A folder row sends every file it lists. */
  "changes:discard": { req: { worktreeId: string; paths: string[] }; res: null };
  /**
   * Ignore these paths in the worktree's root `.gitignore`, creating the file
   * if absent and skipping any line already present. The renderer sends paths
   * rather than patterns: anchoring and glob-escaping are git's rules, so they
   * belong beside the code that writes the file. Returns the patterns actually
   * written, so the UI can say "already ignored" instead of claiming work it
   * did not do.
   */
  "changes:ignore": {
    req: {
      worktreeId: string;
      entries: { path: string; directory: boolean }[];
    };
    res: { added: string[]; gitignorePath: string };
  };
  /** Discard every uncommitted change while preserving ignored files. */
  "changes:discardAll": { req: { worktreeId: string }; res: null };
  "changes:commit": {
    req: { worktreeId: string; message: string; amend?: boolean };
    res: null;
  };
  /** Unified diff for one working-tree file (staged or unstaged). */
  "diff:file": {
    req: { worktreeId: string; path: string; staged: boolean };
    res: string;
  };
  /** Unified diff of the changes a commit introduced. */
  "diff:commit": { req: { worktreeId: string; hash: string }; res: string };
  /** Resolve a full or abbreviated object ID in the selected repository. */
  "commit:lookup": {
    req: { worktreeId: string; hash: string };
    res: Commit | null;
  };
  /** The files a commit touched (rail's commit-scoped list). */
  "commit:files": {
    req: { worktreeId: string; hash: string };
    res: CommitFileChange[];
  };
  /** Summed +/− count for a commit, read lazily by the lineage context card. */
  "commit:stats": {
    req: { worktreeId: string; hash: string };
    res: CommitStats;
  };
  /** Unified diff of ONE file within a commit. */
  "diff:commitFile": {
    req: { worktreeId: string; hash: string; path: string };
    res: string;
  };
  /** Bytes of one side of an image diff, base64 for a data: URL. */
  "diff:image": {
    req: { worktreeId: string; path: string; rev: ImageRevision };
    res: ImagePreview;
  };

  // App settings (Settings window)
  "settings:read": { req: void; res: AppSettingsSnapshot };
  "settings:update": { req: { patch: AppSettingsPatch }; res: AppSettingsSnapshot };

  // Desktop auto-update (Settings → Updates)
  "app:readUpdateStatus": { req: void; res: AppUpdateStatus };
  "app:readUpdateReleases": { req: void; res: AppUpdateReleaseVersions };
  "app:checkForUpdate": { req: void; res: AppUpdateCheckResult };
  "app:installUpdate": { req: void; res: AppUpdateInstallResult };

  // App logs (diagnosability — silent failures must be findable somewhere)
  "logs:read": { req: void; res: LogSnapshot };
  "logs:openWindow": { req: void; res: null };

  // Bundled legal notices (Settings → About and Help menu).
  "app:readDocument": { req: { kind: AppDocumentKind }; res: AppDocument };
  "app:openDocumentWindow": { req: { kind: AppDocumentKind }; res: null };

  "dialog:pickDirectory": { req: void; res: string | null };
  "dialog:pickDirectories": { req: void; res: string[] };

  // Reveal a path in the OS file manager (Finder / Explorer / …).
  "shell:revealPath": { req: { path: string }; res: null };
  // Open a URL in the default browser (e.g. a PR link).
  "shell:openExternal": { req: { url: string }; res: null };
}

export type CommandName = keyof Commands;
export type Req<C extends CommandName> = Commands[C]["req"];
export type Res<C extends CommandName> = Commands[C]["res"];

/** Server → renderer push events. */
export interface Events {
  "profile:changed": ProfileList;
  "repo:changed": { profileId: ProfileId };
  /** Live Git progress for one clone command, correlated by operation id. */
  "repo:cloneProgress": {
    operationId: string;
    profileId: ProfileId;
    progress: CloneProgress;
  };
  /** Live progress for one fork, correlated by operation id. Carries the two
   *  forge-side phases the clone event has no vocabulary for. */
  "repo:forkProgress": {
    operationId: string;
    profileId: ProfileId;
    progress: ForkProgress;
  };
  /** Forge identities that changed, as a delta the renderer patches onto the
   *  tree in place — the same shape `pr:changed` uses, and for the same
   *  reason: a full `repo:list` reload would collapse the sidebar. */
  "repo:identityChanged": {
    profileId: ProfileId;
    identities: { repoId: string; identity: RepoIdentity }[];
  };
  "worktree:changed": { worktreeId: string };
  /**
   * The index or working tree of one worktree moved — re-read `changes:list`.
   * Distinct from `worktree:changed`, which only fires when the *coarse* state
   * (dirty count, head, ahead/behind, …) moved: staging or unstaging a single
   * file leaves every one of those identical, so the Changes list needs its own
   * signal or it silently shows a stale set.
   */
  "changes:changed": { worktreeId: string };
  /** Coarse live pull progress for one worktree. */
  "worktree:pullProgress": {
    worktreeId: string;
    phase: PullProgressPhase;
  };
  /** A worktree finished being removed (streamed during a batch remove). */
  "worktree:removed": { worktreeId: string };
  /**
   * PR status changed for some of a repo's branches — a targeted delta the
   * renderer patches onto the tree in place (no full reload). null clears a
   * branch's PR. Keyed by branch name.
   */
  "pr:changed": { repoId: string; prs: Record<string, PrSummary | null> };
  /** Commit SHA → associated PR delta (null is an authoritative no-PR result). */
  "pr:commitChanged": {
    repoId: string;
    prs: Record<string, PrSummary | null>;
  };
  /**
   * A forge became usable, stopped being usable, or changed what it can do.
   *
   * Pushed by main so the renderer never has to poll for it — the UI repaints
   * the affected surfaces instead of re-probing.
   */
  "forge:statusChanged": { forges: ForgeStatus[] };
  /**
   * A non-blocking proof-backed identity lookup settled. Consumers that
   * requested this commit can repaint without polling or blocking hover.
   */
  "github:commitAuthorIdentityChanged": {
    worktreeId: string;
    commitHash: string;
    lookup: GitHubCommitAuthorIdentityLookup;
  };
  /** Native Profiles-menu actions — handled by whichever window has focus. */
  "ui:newProfile": Record<string, never>;
  "ui:manageProfile": Record<string, never>;
  /** App settings changed (any window) — payload is the fresh snapshot. */
  "settings:changed": AppSettingsSnapshot;
  /** Auto-update status changed — Settings and any future banner subscribe. */
  "app:updateStatus": AppUpdateStatus;
  /** Reveal a repo (and optionally a worktree) in the window bound to
   *  `profileId` — cross-profile ⌘F pick landing in an open window. */
  "ui:revealRepo": {
    profileId: ProfileId;
    repoId: string;
    worktreeId: string | null;
    branch: BranchReveal | null;
  };
  /** A new main-process log line — streamed live to the Logs window. */
  "logs:entry": LogEntry;
}

export type EventChannel = keyof Events;
export type EventPayload<C extends EventChannel> = Events[C];
