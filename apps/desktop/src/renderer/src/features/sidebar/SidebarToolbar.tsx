import { useRef, useState, type ReactElement } from "react";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";
import { PullGlyph } from "../../lib/PullGlyph";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { WrenchGlyph } from "../../lib/WrenchGlyph";
import { useFitLadder } from "../../lib/useFitLadder";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";

/**
 * Steps the row takes, in order, when it does not fit: Add's word goes first,
 * then Fetch all and Pull all drop to their glyphs together. Measured, never a
 * fixed width — design/Sidebar Header Toolbar - UX Review.dc.html, 3b.
 */
export const SIDEBAR_TOOLBAR_FIT_STEPS = [
  "sidebar-toolbar--add-icon",
  "sidebar-toolbar--icons"
] as const;

/** Why each Add menu entry is unavailable, or nothing when it is available. */
export function addMenuReasons(input: {
  hasProfile: boolean;
  rootCount: number;
}): { addFolders?: string; clone?: string; fork?: string } {
  if (!input.hasProfile) {
    const reason = "Load or create a profile first";
    return { addFolders: reason, clone: reason, fork: reason };
  }
  if (input.rootCount === 0) {
    return {
      clone: "Add a repo folder before cloning",
      fork: "Add a repo folder before forking"
    };
  }
  return {};
}

/**
 * The one row of profile-wide actions above the lens row: Add ▾ (Add folders,
 * Clone, Fork), Fetch all, Pull all, and Repository maintenance as a wrench.
 *
 * It replaced five rows in four button styles (252px with the search field,
 * which moved to the title strip). Every accessible name survived the move —
 * "Fetch all repos", "Try pull all", "Repository maintenance…" — and each
 * contains its shorter visible label (SC 2.5.3), so voice control and the E2E
 * suite find them as before.
 */
export function SidebarToolbar({
  hasProfile,
  rootCount,
  repoCount,
  onAddFolder,
  onClone,
  onFork,
  onFetchAll,
  onPullAll,
  onMaintenance
}: {
  hasProfile: boolean;
  rootCount: number;
  repoCount: number;
  onAddFolder: () => void;
  onClone: () => void;
  onFork: () => void;
  onFetchAll: () => void;
  onPullAll: () => void;
  onMaintenance: () => void;
}): ReactElement {
  const tip = useViewportTooltip();
  const rowRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useFitLadder(rowRef, rowRef, lastRef, SIDEBAR_TOOLBAR_FIT_STEPS);

  const reasons = addMenuReasons({ hasProfile, rootCount });
  const syncDisabled = !hasProfile || repoCount === 0;
  const item = (
    label: string,
    reason: string | undefined,
    onSelect: () => void
  ): MenuItem => ({
    type: "item",
    label,
    ...(reason === undefined ? {} : { disabled: true, hint: reason }),
    onSelect
  });

  return (
    <div
      ref={rowRef}
      className="sidebar-toolbar"
      /* A group, not a toolbar: role="toolbar" promises one Tab stop and
         arrow keys between the buttons, and these are four ordinary Tab
         stops. */
      role="group"
      aria-label="Repositories"
    >
      <button
        ref={addRef}
        type="button"
        className="sidebar-toolbar__btn sidebar-toolbar__add"
        aria-label="Add repositories"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        {...hoverTooltip(tip, "Add folders, clone, or fork")}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu((current) =>
            current === null ? { x: rect.left, y: rect.bottom + 4 } : null
          );
        }}
      >
        <PlusGlyph />
        <span className="sidebar-toolbar__label">Add</span>
        <ChevronGlyph size={10} />
      </button>
      {/* "Fetch all repos", not "Fetch all": the Remotes heading in every
          RepoRow carries a button of the same name that fetches all remotes
          of ONE repo. Same words, two blast radii — so the accessible name
          states the wider scope even where the visible label is short.

          The glyphs are the worktree toolbar's own Fetch and Pull marks, so
          each bulk action reads as the same verb as the single one. Neither
          button animates; each opens BulkSyncDialog, which owns progress. */}
      <button
        type="button"
        className="sidebar-toolbar__btn sidebar-toolbar__sync"
        aria-label="Fetch all repos"
        disabled={syncDisabled}
        {...hoverTooltip(
          tip,
          "Fetch and prune stale remote-tracking references in every repository; local branches are kept"
        )}
        onClick={onFetchAll}
      >
        <RefreshGlyph size={12} />
        <span className="sidebar-toolbar__label">Fetch all</span>
      </button>
      <button
        type="button"
        className="sidebar-toolbar__btn sidebar-toolbar__sync"
        aria-label="Try pull all"
        disabled={syncDisabled}
        {...hoverTooltip(tip, "Fast-forward only clean, safe tracked worktrees")}
        onClick={onPullAll}
      >
        <PullGlyph size={12} />
        <span className="sidebar-toolbar__label">Pull all</span>
      </button>
      <button
        ref={lastRef}
        type="button"
        className="sidebar-toolbar__btn sidebar-toolbar__icon"
        aria-label="Repository maintenance…"
        disabled={!hasProfile}
        {...hoverTooltip(
          tip,
          "Repository maintenance… — collect Git garbage, prune finished worktrees, and review leftover local branches"
        )}
        onClick={onMaintenance}
      >
        <WrenchGlyph />
      </button>

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Add repositories"
          triggerRef={addRef}
          items={[
            item("Add folders…", reasons.addFolders, onAddFolder),
            item("Clone…", reasons.clone, onClone),
            item("Fork…", reasons.fork, onFork)
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      {tip.tooltipNode}
    </div>
  );
}
