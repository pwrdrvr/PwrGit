import { useRef, useState, type ReactElement } from "react";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";
import { PullGlyph } from "../../lib/PullGlyph";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { WrenchGlyph } from "../../lib/WrenchGlyph";
import { useFitLadder } from "../../lib/useFitLadder";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { finishedHeadline } from "./BulkSyncToast";
import type { LastBulkSyncRun } from "./useBulkSyncRun";
import {
  FETCH_INTERVALS,
  fetchIntervalLabel,
  fetchIntervalPhrase,
  type FetchInterval,
  type FetchScope,
  type SyncVerb
} from "./bulk-sync-prefs";

/**
 * Steps the row takes, in order, when it does not fit: Add's word goes first,
 * then the sync button drops to its glyph. Measured, never a
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

/** The four things the sync button's face can do, in menu order. */
export const SYNC_ACTIONS: ReadonlyArray<{ verb: SyncVerb; scope: FetchScope }> = [
  { verb: "fetch", scope: "all" },
  { verb: "fetch", scope: "recent" },
  { verb: "pull", scope: "all" },
  { verb: "pull", scope: "recent" }
];

const repositories = (count: number): string =>
  `${count} ${count === 1 ? "repository" : "repositories"}`;

/**
 * The sync face's accessible name, visible label and hover card.
 *
 * The names keep the words the old two buttons had — "Fetch all repos" and
 * "Try pull all" — so voice control and the E2E suite still find each one,
 * and each contains its visible label (SC 2.5.3). "Fetch all repos", not
 * "Fetch all": the Remotes heading in every RepoRow carries a button of that
 * name that fetches ONE repo, so the name states the wider scope.
 */
export function syncFace(input: {
  verb: SyncVerb;
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
  const where = recent
    ? `the ${repositories(count)} in the Focused list`
    : "every repository";
  const lines = [
    input.verb === "pull"
      ? `Fetch ${where}, then fast-forward only clean, safely tracked branches.`
      : `Fetch and prune stale remote-tracking references in ${where}; local branches are kept.`
  ];
  const every = fetchIntervalPhrase(input.interval);
  if (every !== null) {
    lines.push(
      `${input.verb === "pull" ? "Pulling" : "Fetching"} automatically ${every}.`
    );
  }
  if (input.busy) lines.push("Running now — click to watch.");
  else if (input.lastAuto !== undefined) lines.push(input.lastAuto);
  const word = recent ? "recent" : "all";
  return input.verb === "pull"
    ? {
        name: `Try pull ${word}`,
        label: `Pull ${word}`,
        tooltip: lines.join(" "),
        count
      }
    : {
        name: `Fetch ${word} repos`,
        label: `Fetch ${word}`,
        tooltip: lines.join(" "),
        count
      };
}

/** Show last run's second line: what it did, when, and whether you ran it. */
export function lastRunHint(last: LastBulkSyncRun): string {
  const { success, partial } = last.summary.counts.repos;
  const what = finishedHeadline(
    last.mode,
    last.summary.results.length,
    success + partial
  );
  const time = last.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // A cancelled run's counts stop where it stopped; say so, or the rest read
  // as skipped or failed.
  const cancelled = last.summary.cancelled ? " · cancelled" : "";
  return `${what}${cancelled} · ${last.auto ? "automatic, " : ""}${time}`;
}

/**
 * The one row of profile-wide actions above the lens row: Add ▾ (Add folders,
 * Clone, Fork), the sync button, and Repository maintenance as a wrench.
 *
 * The sync button is one split button for Fetch and Try pull: Try pull
 * already fetches every repository before it fast-forwards, so two buttons
 * offered the same first half twice. The face runs the remembered verb and
 * scope and wears its name. The chevron's menu sets the button up (which
 * verb and scope the face runs, and how often the timer runs it) and stays
 * open while you do; the face runs it. design/Fetch Toast and Scope - UX
 * Review.dc.html, turn 5.
 */
export function SidebarToolbar({
  hasProfile,
  rootCount,
  repoCount,
  recentCount = repoCount,
  syncVerb = "fetch",
  syncScope = "all",
  fetchInterval = 0,
  syncBusy = false,
  lastAutoRun,
  lastRun = null,
  onAddFolder,
  onClone,
  onFork,
  onSync,
  onPickSync,
  onPickFetchInterval,
  onShowRun,
  onMaintenance
}: {
  hasProfile: boolean;
  rootCount: number;
  repoCount: number;
  /** Repositories in the Focused list, which is what "recent" covers. */
  recentCount?: number;
  syncVerb?: SyncVerb;
  syncScope?: FetchScope;
  fetchInterval?: FetchInterval;
  /** A run is in flight, possibly a timed fetch nobody is watching. */
  syncBusy?: boolean;
  lastAutoRun?: string | undefined;
  /** The newest finished run, for Sync options → Show last run. */
  lastRun?: LastBulkSyncRun | null;
  /** Show the run going now, or the last one's results. */
  onShowRun?: () => void;
  onAddFolder: () => void;
  onClone: () => void;
  onFork: () => void;
  /** The face: run the remembered verb and scope, or show the run in flight. */
  onSync: () => void;
  /** Remember a verb and scope as the face. Runs nothing: the face does. */
  onPickSync?: (verb: SyncVerb, scope: FetchScope) => void;
  onPickFetchInterval?: (minutes: FetchInterval) => void;
  onMaintenance: () => void;
}): ReactElement {
  const tip = useViewportTooltip();
  const rowRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const syncMenuRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [syncMenu, setSyncMenu] = useState<{ x: number; y: number } | null>(
    null
  );
  useFitLadder(rowRef, rowRef, lastRef, SIDEBAR_TOOLBAR_FIT_STEPS);

  const reasons = addMenuReasons({ hasProfile, rootCount });
  const syncDisabled = !hasProfile || repoCount === 0;
  const face = syncFace({
    verb: syncVerb,
    scope: syncScope,
    repoCount,
    recentCount,
    interval: fetchInterval,
    busy: syncBusy,
    lastAuto: lastAutoRun
  });
  const syncItems: MenuItem[] = [
    ...SYNC_ACTIONS.map(({ verb, scope }): MenuItem => {
      const recent = scope === "recent";
      const count = recent ? recentCount : repoCount;
      const what = recent
        ? `The Focused list · ${repositories(count)}`
        : repositories(count);
      return {
        type: "item",
        label: `${verb === "pull" ? "Pull" : "Fetch"} ${recent ? "recent" : "all"} repositories`,
        hint:
          recent && count === 0
            ? "Nothing in the Focused list yet"
            : verb === "pull"
              ? `${what} · then fast-forward clean branches`
              : what,
        checked: syncVerb === verb && syncScope === scope,
        radio: true,
        keepOpen: true,
        ...(count === 0 ? { disabled: true } : {}),
        onSelect: () => onPickSync?.(verb, scope)
      };
    }),
    { type: "sep" },
    // The timer runs the face, so the heading names its verb.
    {
      type: "heading",
      label: syncVerb === "pull" ? "Pull automatically" : "Fetch automatically"
    },
    ...FETCH_INTERVALS.map(
      (minutes): MenuItem => ({
        type: "item",
        label: fetchIntervalLabel(minutes),
        checked: fetchInterval === minutes,
        radio: true,
        keepOpen: true,
        onSelect: () => onPickFetchInterval?.(minutes)
      })
    ),
    { type: "sep" },
    // A timed run raises no toast, and a finished toast leaves: this is how
    // either is read afterwards. It opens the dialog, so the menu closes.
    syncBusy
      ? {
          type: "item",
          label: "Show the running sync",
          inset: true,
          onSelect: () => onShowRun?.()
        }
      : lastRun === null
        ? {
            type: "item",
            label: "Show last run",
            inset: true,
            disabled: true,
            hint: "Nothing has run yet",
            onSelect: () => undefined
          }
        : {
            type: "item",
            label: "Show last run",
            inset: true,
            hint: lastRunHint(lastRun),
            onSelect: () => onShowRun?.()
          }
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
         arrow keys between the buttons, and these are ordinary Tab stops. */
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
      {/* The glyphs are the worktree toolbar's own Fetch and Pull marks, so
          each bulk action reads as the same verb as the single one. A
          circular arrow turns while busy (aria-busy); Pull's arrow means
          "down", so it swaps to the ring instead (styles/AGENTS.md). */}
      <div className="sidebar-toolbar__split">
        <button
          type="button"
          className="sidebar-toolbar__btn sidebar-toolbar__sync"
          aria-label={face.name}
          aria-busy={syncBusy}
          disabled={!hasProfile || face.count === 0}
          {...hoverTooltip(tip, face.tooltip)}
          onClick={onSync}
        >
          {syncVerb === "fetch" ? (
            <RefreshGlyph size={12} />
          ) : syncBusy ? (
            <span className="wt-btn__spinner" aria-hidden="true" />
          ) : (
            <PullGlyph size={12} />
          )}
          <span className="sidebar-toolbar__label">{face.label}</span>
        </button>
        <button
          ref={syncMenuRef}
          type="button"
          className="sidebar-toolbar__btn sidebar-toolbar__chevron"
          aria-label="Sync options"
          aria-haspopup="menu"
          aria-expanded={syncMenu !== null}
          disabled={syncDisabled}
          {...hoverTooltip(
            tip,
            "Fetch or pull, all or recent — and run it automatically"
          )}
          onClick={(event) => {
            const rect = (
              event.currentTarget.parentElement ?? event.currentTarget
            ).getBoundingClientRect();
            setSyncMenu((current) =>
              current === null ? { x: rect.left, y: rect.bottom + 4 } : null
            );
          }}
        >
          {/* Up while its menu is open, as PwrAgnt's Send caret flips: the
              chevron says which control opened the menu. Drawn, not rotated
              (lib/ChevronGlyph.tsx). */}
          <ChevronGlyph size={10} up={syncMenu !== null} />
        </button>
      </div>
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
      {syncMenu !== null && (
        <ContextMenu
          x={syncMenu.x}
          y={syncMenu.y}
          label="Sync options"
          triggerRef={syncMenuRef}
          items={syncItems}
          onClose={() => setSyncMenu(null)}
        />
      )}
      {tip.tooltipNode}
    </div>
  );
}
