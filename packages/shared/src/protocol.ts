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
  Profile,
  ProfileId,
  Repo,
  RepoSearchHit
} from "./types";

export type ProfileList = {
  activeProfileId: ProfileId | null;
  profiles: Profile[];
};

export type CreateProfileRequest = {
  name: string;
  email: string;
  mono?: string;
  kind?: string;
  roots?: string[];
};

export interface Commands {
  /** Liveness probe — proves the command-bus round-trip end to end. */
  ping: { req: void; res: string };

  // Profiles (U5)
  "profile:list": { req: void; res: ProfileList };
  "profile:switch": { req: { profileId: ProfileId }; res: ProfileList };
  "profile:create": { req: CreateProfileRequest; res: Profile };

  // Repos & discovery (U6)
  "repo:list": { req: { profileId?: ProfileId }; res: Repo[] };
  "repo:rescan": { req: { profileId?: ProfileId }; res: Repo[] };
  "repo:add": { req: { profileId: ProfileId; path: string }; res: Repo };
  "repo:search": { req: { query: string }; res: RepoSearchHit[] };
}

export type CommandName = keyof Commands;
export type Req<C extends CommandName> = Commands[C]["req"];
export type Res<C extends CommandName> = Commands[C]["res"];

/** Server → renderer push events. */
export interface Events {
  "profile:changed": ProfileList;
  "repo:changed": { profileId: ProfileId };
  "worktree:changed": { worktreeId: string };
}

export type EventChannel = keyof Events;
export type EventPayload<C extends EventChannel> = Events[C];
