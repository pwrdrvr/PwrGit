/**
 * Find my repositories: the home-folder search's answer, shared by main (which
 * walks) and the renderer (which draws the checklist and counts what is
 * checked). Design: `design/New User Journey - UX Review.dc.html`, turn 2.
 *
 * The search proposes FOLDERS, never single repositories: PwrGit's model is
 * a folder the profile keeps looking in. Nothing is added until the user
 * confirms the list.
 */

/** Folder names offered when the user has nowhere to put repositories yet.
 *  The three spellings people actually use. Main creates one of these, under
 *  the home folder, only by this name. */
export const SUGGESTED_ROOTS = ["projects", "github", "git"] as const;
export type SuggestedRootName = (typeof SUGGESTED_ROOTS)[number];

export function isSuggestedRootName(name: string): name is SuggestedRootName {
  return (SUGGESTED_ROOTS as readonly string[]).includes(name);
}

/** A suggested folder as main sees it on this machine. */
export type SuggestedRoot = {
  name: SuggestedRootName;
  /** Absolute, under the home folder. */
  path: string;
  /** `~/name`, for display. */
  display: string;
  exists: boolean;
};

/**
 * A folder that may not exist yet, named the only two ways main accepts:
 * one of `SUGGESTED_ROOTS` under the home folder, or a path the system folder
 * picker returned to this app. Main refuses any other path, so a renderer
 * cannot make it create or register an arbitrary directory.
 */
export type NewRootChoice =
  | { kind: "suggested"; name: SuggestedRootName }
  | { kind: "picked"; path: string };

/** How deep below the home folder the search looks. Decided 2026-11-13: two
 *  levels misses the `~/github/owner/repo` layout the wizard calls expected. */
export const REPO_SEARCH_DEPTH = 3;

/**
 * The search's budget. Neither figure is a measurement of a typical home
 * folder; see `repo-search.ts` in main for why these were chosen.
 */
export const REPO_SEARCH_MAX_FOLDERS = 20_000;
export const REPO_SEARCH_MAX_MS = 10_000;

/** Why a proposed folder starts unchecked, when it does. */
export type ProposedFolderNote =
  /** Every checkout in it is a linked worktree of a repository found in
   *  another proposed folder, which already brings it in. */
  | { kind: "worktrees-of"; repositoryFolders: string[] }
  /** Every checkout in it belongs to the repository in the home folder
   *  itself: its submodules or linked worktrees. */
  | { kind: "home-repository" }
  /** Its checkouts are linked worktrees of a bare repository, which the
   *  scan cannot show yet (it drops a repository whose main entry is bare). */
  | { kind: "bare" }
  /** Already a folder of this profile. */
  | { kind: "added" }
  /** Overlaps a folder of another profile; adding it would be refused. */
  | { kind: "other-profile"; profileName: string; otherRoot: string };

/** One repository as the search sees it: every checkout it found, folded. */
export type FoundRepository = {
  /** Git's common directory, resolved. Two checkouts with the same key are
   *  one repository, as the scan will index them. */
  key: string;
  /** The repository's folder name, for the row's sample. */
  name: string;
  /** Checkouts of it inside this proposed folder. */
  checkouts: string[];
  /** Whether the repository's own `.git` directory was found by the search
   *  (anywhere), rather than only a linked worktree pointing at it. */
  primaryFound: boolean;
  /** False for a bare repository: found, but not something the scan lists. */
  indexable: boolean;
};

export type ProposedFolder = {
  path: string;
  /** `~/code`, for display. */
  display: string;
  /** The folder is itself a repository (a `.git` at its root). */
  isRepository: boolean;
  /** Repositories with a checkout in this folder. */
  repositories: FoundRepository[];
  /** Linked worktrees in this folder, of any repository. */
  worktreeCount: number;
  /** Owner-style subfolders the repositories sit in (`~/github/acme`), for
   *  "in 3 owner folders". */
  ownerFolders: number;
  checked: boolean;
  /** False when adding it would be refused or would add nothing. */
  selectable: boolean;
  note: ProposedFolderNote | null;
};

export type RepoSearchStop =
  /** The folder budget ran out. */
  | "folders"
  /** The time budget ran out. */
  | "time"
  /** The user pressed Stop. */
  | "stopped";

export type RepoSearchResult = {
  home: string;
  folders: ProposedFolder[];
  /** Directories read, the home folder included. */
  foldersOpened: number;
  /** Null when the search looked everywhere it meant to. */
  stoppedEarly: RepoSearchStop | null;
  /** Whether Documents, Desktop and Downloads were part of this search. */
  includedProtected: boolean;
  /** Protected folders that exist and were left out of this search. Empty on
   *  a platform that does not ask before opening them. */
  protectedSkipped: string[];
  /** Folders the operating system refused to list (macOS privacy). */
  refused: string[];
  /** Cloud-synced folders left out: opening them may fetch from the network. */
  cloudSkipped: string[];
  /** Whether Documents, Desktop and Downloads are asked for on this platform
   *  (macOS) rather than searched with everything else. */
  protectedAskFirst: boolean;
  /** The home folder is itself a repository. Never proposed. */
  homeIsRepository: boolean;
};

export type RepoSearchProgress = {
  searchId: string;
  profileId: string;
  foldersOpened: number;
  repositoriesFound: number;
};

/**
 * How many repositories adding these folders brings into the sidebar: every
 * checkout in a checked folder, folded into its repository, each repository
 * once. A linked worktree whose repository lies outside the checked folders
 * still brings that repository in, because the scan resolves every checkout
 * to its repository. This is the headline the primary button promises, and
 * the property test holds it to what `rescanProfile` indexes.
 */
export function repositoriesInFolders(
  folders: readonly ProposedFolder[],
  checked: ReadonlySet<string>
): number {
  const keys = new Set<string>();
  for (const folder of folders) {
    if (!checked.has(folder.path)) continue;
    for (const repo of folder.repositories) {
      if (repo.indexable) keys.add(repo.key);
    }
  }
  return keys.size;
}

/** Folders the checklist starts with checked. */
export function initiallyChecked(
  folders: readonly ProposedFolder[]
): Set<string> {
  return new Set(
    folders.filter((f) => f.checked && f.selectable).map((f) => f.path)
  );
}

/** Repositories across every proposed folder that the scan would index,
 *  each once: the "N repositories so far" and "Found N" figure. */
export function repositoriesFound(folders: readonly ProposedFolder[]): number {
  return repositoriesInFolders(
    folders,
    new Set(folders.map((f) => f.path))
  );
}
