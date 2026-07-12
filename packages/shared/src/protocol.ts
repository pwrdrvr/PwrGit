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
  AgentStatus,
  BranchRef,
  ChangeSet,
  GraphLog,
  LaneGraph,
  PrSummary,
  Profile,
  ProfileId,
  RebaseCommitRef,
  RebasePlan,
  Repo,
  RepoSearchHit,
  WorktreeState
} from "./types";

export type ProfileList = {
  activeProfileId: ProfileId | null;
  profiles: Profile[];
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

export interface Commands {
  /** Liveness probe — proves the command-bus round-trip end to end. */
  ping: { req: void; res: string };

  // Profiles (U5). One window per profile: "switching" means opening (or
  // focusing) that profile's window, never repointing the current one.
  "profile:list": { req: void; res: ProfileList };
  "profile:switch": { req: { profileId: ProfileId }; res: ProfileList };
  /** Open (or focus) the window bound to a profile; optionally reveal a repo
   *  there once it's up (used by cross-profile ⌘F picks). */
  "profile:openWindow": {
    req: { profileId: ProfileId; revealRepoId?: string };
    res: null;
  };
  /** A window asks, once on boot, whether a repo reveal is queued for it. */
  "window:consumeReveal": {
    req: { profileId: ProfileId };
    res: { repoId: string | null };
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
  "repo:add": { req: { profileId: ProfileId; path: string }; res: Repo };
  "repo:search": { req: { query: string }; res: RepoSearchHit[] };
  "repo:setPin": { req: { repoId: string; pinned: boolean }; res: null };
  "repo:computeState": { req: { repoId: string }; res: null };

  // GitHub PR status (bulk, cached)
  "pr:refresh": { req: { repoId: string; force?: boolean }; res: null };
  "github:status": {
    req: void;
    res: { installed: boolean; loggedIn: boolean };
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
    req: { repoId: string; branch: string; newBranch: boolean };
    res: null;
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

  // Branch switching — list local + remote branches, check one out in place
  "branch:list": { req: { worktreeId: string }; res: BranchRef[] };
  "branch:switch": { req: { worktreeId: string; branch: string }; res: null };

  // Remotes (U9 / U13)
  "remote:fetch": { req: { worktreeId: string }; res: null };
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

  // Agent + rebase assistant (U15 / U16)
  "agent:status": { req: void; res: AgentStatus };
  "rebase:draft": {
    req: {
      worktreeId: string;
      commits: RebaseCommitRef[];
      op: "squash" | "reorder";
    };
    res: RebasePlan;
  };
  "rebase:apply": {
    req: {
      worktreeId: string;
      commits: RebaseCommitRef[];
      op: "squash" | "reorder";
    };
    res: null;
  };

  // Changes (U11 / U12)
  "changes:list": { req: { worktreeId: string }; res: ChangeSet };
  "changes:stage": { req: { worktreeId: string; path: string }; res: null };
  "changes:unstage": { req: { worktreeId: string; path: string }; res: null };
  /** Discard a file's uncommitted changes (revert to HEAD, or delete if new). */
  "changes:discard": { req: { worktreeId: string; path: string }; res: null };
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
  "worktree:changed": { worktreeId: string };
  /** A worktree finished being removed (streamed during a batch remove). */
  "worktree:removed": { worktreeId: string };
  /**
   * PR status changed for some of a repo's branches — a targeted delta the
   * renderer patches onto the tree in place (no full reload). null clears a
   * branch's PR. Keyed by branch name.
   */
  "pr:changed": { repoId: string; prs: Record<string, PrSummary | null> };
  /** Native Profiles-menu actions — handled by whichever window has focus. */
  "ui:newProfile": Record<string, never>;
  "ui:manageProfile": Record<string, never>;
  /** Reveal a repo in the window bound to `profileId` (cross-profile ⌘F pick). */
  "ui:revealRepo": { profileId: ProfileId; repoId: string };
}

export type EventChannel = keyof Events;
export type EventPayload<C extends EventChannel> = Events[C];
