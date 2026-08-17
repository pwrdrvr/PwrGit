import { homedir } from "node:os";
import { join } from "node:path";
import type { SettingsService } from "../settings/settings-service";

/** Slashes are legal in branch names but nest directories — flatten them. */
export const slugBranch = (branch: string): string => branch.replace(/\//g, "-");

/** Root under which PwrGit-managed worktrees are created. */
export function worktreeRoot(settings: SettingsService): string {
  return settings.get().worktreeRoot ?? join(homedir(), "wt");
}

/**
 * Where a worktree for `branch` lands. Shared by `worktree:create`, the
 * branch-from-commit handler, and the dialog's path preview, so what the user
 * is shown before creating is what actually gets created.
 */
export function worktreePathFor(
  settings: SettingsService,
  repoName: string,
  branch: string
): string {
  return join(worktreeRoot(settings), repoName, slugBranch(branch));
}
