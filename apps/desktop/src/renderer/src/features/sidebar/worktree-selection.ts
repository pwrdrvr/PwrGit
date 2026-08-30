import type { Repo, Worktree } from "@pwrgit/shared";

export type WorktreeSelection = { repoId: string; worktreeId: string };

const STORAGE_PREFIX = "pwrgit.worktreeSelection.";

const storageKey = (profileId: string): string =>
  `${STORAGE_PREFIX}${profileId}`;

/**
 * Read the last worktree viewed in one profile. The value is renderer-local
 * on purpose: each profile already has its own window, and selecting a row is
 * UI state rather than repository state that main needs to coordinate.
 */
export function readStoredWorktreeSelection(
  profileId: string
): WorktreeSelection | null {
  try {
    const raw = window.localStorage.getItem(storageKey(profileId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("repoId" in parsed) ||
      !("worktreeId" in parsed) ||
      typeof parsed.repoId !== "string" ||
      parsed.repoId === "" ||
      typeof parsed.worktreeId !== "string" ||
      parsed.worktreeId === ""
    ) {
      return null;
    }
    return { repoId: parsed.repoId, worktreeId: parsed.worktreeId };
  } catch {
    // Storage can be unavailable (private mode / quota policy), and an older
    // build may have left malformed JSON. Neither should block app startup.
    return null;
  }
}

export function storeWorktreeSelection(
  profileId: string,
  selection: WorktreeSelection
): void {
  try {
    window.localStorage.setItem(
      storageKey(profileId),
      JSON.stringify(selection)
    );
  } catch {
    // Selection persistence is best-effort; the current session still works.
  }
}

const primarySelection = (
  repo: Repo,
  worktrees: readonly Worktree[] = repo.worktrees
): WorktreeSelection | null => {
  const worktree =
    worktrees.find((candidate) => candidate.isPrimary) ?? worktrees[0];
  return worktree === undefined
    ? null
    : { repoId: repo.id, worktreeId: worktree.id };
};

/**
 * Reconcile a stored/current selection against the latest repository tree.
 *
 * An exact match wins. If that linked worktree was removed, stay in the same
 * repository by selecting its primary checkout. If the whole repository is
 * gone, use the first repository that has a checkout. Empty repositories are
 * skipped rather than manufacturing an invalid selection.
 */
export function resolveWorktreeSelection(
  repos: readonly Repo[],
  preferred: WorktreeSelection | null
): WorktreeSelection | null {
  if (preferred !== null) {
    const repo = repos.find((candidate) => candidate.id === preferred.repoId);
    const exact = repo?.worktrees.find(
      (worktree) => worktree.id === preferred.worktreeId
    );
    if (repo !== undefined && exact !== undefined) return preferred;
    if (repo !== undefined) {
      const fallback = primarySelection(repo);
      if (fallback !== null) return fallback;
    }
  }

  for (const repo of repos) {
    const fallback = primarySelection(repo);
    if (fallback !== null) return fallback;
  }
  return null;
}
