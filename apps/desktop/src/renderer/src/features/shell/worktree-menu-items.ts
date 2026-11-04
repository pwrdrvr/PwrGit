import type { Repo, Worktree } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import type { MenuItem } from "./ContextMenu";
import { revealLabel, revealPath } from "./reveal";

/** "Fork owner/name…" once the forge has named the repository; the folder
 *  name until then, rather than a URL guessed from it. */
export function forkMenuLabel(repo: Pick<Repo, "name" | "identity">): string {
  return `Fork ${repo.identity?.nameWithOwner ?? repo.name}…`;
}

/** Said by a primary checkout's disabled Remove: it goes with the repository,
 *  and the repository's own menu is the row above it. */
export const PRIMARY_REMOVE_HINT =
  "Goes with the repository: Remove repository… on its row.";

/** Said by a missing checkout's disabled Reset: there is nothing to reset. */
export const MISSING_RESET_HINT = "Its folder is missing.";

/**
 * One worktree's actions, in one order, for every surface that offers them:
 * the sidebar row's kebab, its right-click, and the graph header's kebab.
 *
 * They were three lists, and they drifted: the right-click had no Reset, the
 * kebab hid Remove on the primary checkout where the right-click disabled it,
 * and only the header could Fork. An entry that cannot run here stays, disabled
 * with its reason, so the menu reads the same on every row.
 */
export function worktreeMenuItems({
  worktree,
  platform,
  fork,
  onResetToRemote,
  onRemove
}: {
  worktree: Worktree;
  platform?: string;
  /** Fork the repository this worktree belongs to. A checkout's menu is where
   *  people look when they are "on main" and want a copy of their own, and
   *  the read-only chip only appears once the forge has answered. */
  fork?: { label: string; onSelect: () => void };
  onResetToRemote?: () => void;
  /** Absent where the surface does not remove (the graph header). */
  onRemove?: () => void;
}): MenuItem[] {
  const missing = worktree.missing === true;
  const items: MenuItem[] = [
    {
      type: "item",
      label: "Copy branch name",
      onSelect: () => void copyText(worktree.branch)
    },
    {
      type: "item",
      label: "Copy path",
      onSelect: () => void copyText(worktree.path)
    },
    {
      type: "item",
      label: revealLabel(platform),
      onSelect: () => revealPath(worktree.path)
    }
  ];
  if (fork !== undefined || onResetToRemote !== undefined) {
    items.push({ type: "sep" });
  }
  if (fork !== undefined) {
    items.push({ type: "item", label: fork.label, onSelect: fork.onSelect });
  }
  if (onResetToRemote !== undefined) {
    items.push({
      type: "item",
      label: "Reset to remote branch…",
      disabled: missing,
      ...(missing ? { hint: MISSING_RESET_HINT } : {}),
      onSelect: onResetToRemote
    });
  }
  if (onRemove !== undefined) {
    items.push(
      { type: "sep" },
      {
        type: "item",
        // No ellipsis: one clean worktree goes at once; only a dirty one asks.
        label: "Remove worktree",
        danger: true,
        disabled: worktree.isPrimary,
        ...(worktree.isPrimary ? { hint: PRIMARY_REMOVE_HINT } : {}),
        onSelect: onRemove
      }
    );
  }
  return items;
}
