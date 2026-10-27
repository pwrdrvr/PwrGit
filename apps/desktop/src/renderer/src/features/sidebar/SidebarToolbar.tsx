import { useRef, useState, type ReactElement } from "react";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";
import { PullGlyph } from "../../lib/PullGlyph";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { WrenchGlyph } from "../../lib/WrenchGlyph";
import { useFitLadder } from "../../lib/useFitLadder";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import {
  FETCH_INTERVALS,
  fetchIntervalLabel,
  fetchIntervalPhrase,
  type FetchInterval,
  type FetchScope
} from "./bulk-sync-prefs";

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
/** The Fetch face's accessible name, visible label and hover card. */
export function fetchFace(input: {
  scope: FetchScope;
  repoCount: number;
  recentCount: number;
  interval: FetchInterval;
  busy: boolean;
  /** The last timed run's result, when it is worth a line. */
  lastAuto?: string | undefined;
}): { name: string; label: string; tooltip: string; count: number } {
  const recent = input.scope === "recent";
  const count = recent ? input.recentCount : input.repoCount;
  const lines = [
    recent
      ? `Fetch and prune the ${count} ${count === 1 ? "repository" : "repositories"} in the Focused list; local branches are kept`
      : "Fetch and prune stale remote-tracking references in every repository; local branches are kept"
  ];
  const every = fetchIntervalPhrase(input.interval);
  if (every !== null) lines.push(`Fetching automatically ${every}.`);
  if (input.busy) lines.push("Running now — click to watch.");
  else if (input.lastAuto !== undefined) lines.push(input.lastAuto);
  return {
    name: recent ? "Fetch recent repos" : "Fetch all repos",
    label: recent ? "Fetch recent" : "Fetch all",
    tooltip: lines.join(" "),
    count
  };
}

export function SidebarToolbar({
  hasProfile,
  rootCount,
  repoCount,
  recentCount = repoCount,
  fetchScope = "all",
  fetchInterval = 0,
  fetchBusy = false,
  lastAutoFetch,
  onAddFolder,
  onClone,
  onFork,
  onFetchAll,
  onPickFetchScope,
  onPickFetchInterval,
  onPullAll,
  onMaintenance
}: {
  hasProfile: boolean;
  rootCount: number;
  repoCount: number;
  /** Repositories in the Focused list, which is what Fetch recent fetches. */
  recentCount?: number;
  fetchScope?: FetchScope;
  fetchInterval?: FetchInterval;
  /** A fetch is running, possibly a timed one nobody is watching. */
  fetchBusy?: boolean;
  lastAutoFetch?: string | undefined;
  onAddFolder: () => void;
  onClone: () => void;
  onFork: () => void;
  /** The face: fetch the remembered scope, or show the run in flight. */
  onFetchAll: () => void;
  /** Remember a scope and fetch it now. */
  onPickFetchScope?: (scope: FetchScope) => void;
  onPickFetchInterval?: (minutes: FetchInterval) => void;
  onPullAll: () => void;
  onMaintenance: () => void;
}): ReactElement {
  const tip = useViewportTooltip();
  const rowRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const fetchMenuRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [fetchMenu, setFetchMenu] = useState<{ x: number; y: number } | null>(
    null
  );
  useFitLadder(rowRef, rowRef, lastRef, SIDEBAR_TOOLBAR_FIT_STEPS);

  const reasons = addMenuReasons({ hasProfile, rootCount });
  const syncDisabled = !hasProfile || repoCount === 0;
  const face = fetchFace({
    scope: fetchScope,
    repoCount,
    recentCount,
    interval: fetchInterval,
    busy: fetchBusy,
    lastAuto: lastAutoFetch
  });
  const fetchItems: MenuItem[] = [
    {
      type: "item",
      label: "Fetch all repositories",
      hint: `${repoCount} ${repoCount === 1 ? "repository" : "repositories"}`,
      checked: fetchScope === "all",
      radio: true,
      onSelect: () => onPickFetchScope?.("all")
    },
    {
      type: "item",
      label: "Fetch recent repositories",
      hint:
        recentCount === 0
          ? "Nothing in the Focused list yet"
          : `The Focused list · ${recentCount} ${recentCount === 1 ? "repository" : "repositories"}`,
      checked: fetchScope === "recent",
      radio: true,
      ...(recentCount === 0 ? { disabled: true } : {}),
      onSelect: () => onPickFetchScope?.("recent")
    },
    { type: "sep" },
    { type: "heading", label: "Fetch automatically" },
    ...FETCH_INTERVALS.map(
      (minutes): MenuItem => ({
        type: "item",
        label: fetchIntervalLabel(minutes),
        checked: fetchInterval === minutes,
        radio: true,
        onSelect: () => onPickFetchInterval?.(minutes)
      })
    )
  ];
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
      {/* A split button: the face runs the remembered scope and wears its
          name, the chevron picks the scope and the automatic interval.
          design/Fetch Toast and Scope - UX Review.dc.html, turn 3. */}
      <div className="sidebar-toolbar__split">
        <button
          type="button"
          className="sidebar-toolbar__btn sidebar-toolbar__sync"
          aria-label={face.name}
          aria-busy={fetchBusy}
          disabled={!hasProfile || face.count === 0}
          {...hoverTooltip(tip, face.tooltip)}
          onClick={onFetchAll}
        >
          <RefreshGlyph size={12} />
          <span className="sidebar-toolbar__label">{face.label}</span>
        </button>
        <button
          ref={fetchMenuRef}
          type="button"
          className="sidebar-toolbar__btn sidebar-toolbar__chevron"
          aria-label="Fetch options"
          aria-haspopup="menu"
          aria-expanded={fetchMenu !== null}
          disabled={syncDisabled}
          {...hoverTooltip(tip, "Fetch all or recent, and fetch automatically")}
          onClick={(event) => {
            const rect = (
              event.currentTarget.parentElement ?? event.currentTarget
            ).getBoundingClientRect();
            setFetchMenu((current) =>
              current === null ? { x: rect.left, y: rect.bottom + 4 } : null
            );
          }}
        >
          <ChevronGlyph size={10} />
        </button>
      </div>
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
      {fetchMenu !== null && (
        <ContextMenu
          x={fetchMenu.x}
          y={fetchMenu.y}
          label="Fetch options"
          triggerRef={fetchMenuRef}
          items={fetchItems}
          onClose={() => setFetchMenu(null)}
        />
      )}
      {tip.tooltipNode}
    </div>
  );
}
