import type { Repo } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { isMacPlatform, shortcutLabel } from "../../lib/platform";
import type { MenuItem } from "../shell/ContextMenu";
import { revealLabel, revealPath } from "../shell/reveal";
import { forkMenuLabel } from "../shell/worktree-menu-items";

export type RepoMenuActions = {
  onTogglePin: () => void;
  /** One step among the pins the lens shows (⌘⇧↑/↓). */
  onMove: (direction: "up" | "down") => void;
  onFork: () => void;
  onManageRemotes: () => void;
  onOpenSetup: () => void;
  onRefreshForgeInfo: () => void;
  onHide: () => void;
  onRemove: () => void;
};

/** The ⌘⇧↑/↓ move, in `aria-keyshortcuts` form. */
function moveKeyshortcuts(direction: "up" | "down", platform: string): string {
  return `${isMacPlatform(platform) ? "Meta" : "Control"}+Shift+${
    direction === "up" ? "ArrowUp" : "ArrowDown"
  }`;
}

/**
 * One repository's actions, in one order, for every surface that offers them:
 * the tree row's kebab, its right-click and Menu key, and a right-click on its
 * name in the repository index. PwrAgnt's project index opens the project
 * header's own menu the same way (`openProjectIndexContextMenu`), so the two
 * can never offer different lists.
 *
 * The order is PwrAgnt's: pin first (and, for a pin, the moves), then the
 * path, then the repository's own verbs, and leaving the list last.
 * Design: `design/Repo Index Context Menu - UX Review.dc.html`, 2a and 2b.
 */
export function repoMenuItems({
  repo,
  platform,
  arrangeable,
  moveRoom,
  removeHint,
  actions
}: {
  repo: Pick<Repo, "name" | "path" | "pinned" | "identity">;
  platform: string;
  /** The repository is pinned, so it has a place in the hand order and moves. */
  arrangeable: boolean;
  /** Whether a pin has a neighbour above and below it in the lens. */
  moveRoom: { up: boolean; down: boolean };
  removeHint: string;
  actions: RepoMenuActions;
}): MenuItem[] {
  const move = (direction: "up" | "down"): MenuItem => ({
    type: "item",
    label: direction === "up" ? "Move up" : "Move down",
    disabled: !moveRoom[direction],
    shortcut: shortcutLabel(
      { key: direction === "up" ? "ArrowUp" : "ArrowDown", shift: true },
      platform
    ),
    keyshortcuts: moveKeyshortcuts(direction, platform),
    onSelect: () => actions.onMove(direction)
  });
  return [
    {
      type: "item",
      label: repo.pinned ? "Unpin repository" : "Pin repository",
      onSelect: actions.onTogglePin
    },
    ...(arrangeable ? [move("up"), move("down")] : []),
    { type: "sep" },
    {
      type: "item",
      label: revealLabel(platform),
      onSelect: () => revealPath(repo.path)
    },
    { type: "item", label: "Copy path", onSelect: () => void copyText(repo.path) },
    { type: "sep" },
    { type: "item", label: forkMenuLabel(repo), onSelect: actions.onFork },
    { type: "item", label: "Manage remotes…", onSelect: actions.onManageRemotes },
    { type: "item", label: "Repository setup…", onSelect: actions.onOpenSetup },
    { type: "sep" },
    {
      type: "item",
      label: "Refresh forge info",
      onSelect: actions.onRefreshForgeInfo
    },
    { type: "sep" },
    {
      type: "item",
      label: "Hide repository",
      hint: "Stays on disk. Unhide from the sidebar's Hidden list.",
      onSelect: actions.onHide
    },
    {
      type: "item",
      label: "Remove repository…",
      danger: true,
      hint: removeHint,
      onSelect: actions.onRemove
    }
  ];
}
