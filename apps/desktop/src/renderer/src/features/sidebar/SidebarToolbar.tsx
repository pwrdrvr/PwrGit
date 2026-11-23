import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode
} from "react";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";
import { PullGlyph } from "../../lib/PullGlyph";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { WrenchGlyph } from "../../lib/WrenchGlyph";
import { useFitLadder } from "../../lib/useFitLadder";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { finishedHeadline } from "./BulkSyncToast";
import { OutcomeBar } from "./BulkSyncStatus";
import { formatElapsed } from "../remote/remote-activity";
import { useSecondsClock } from "../../state/useRemoteActivity";
import {
  BULK_SYNC_OUTCOMES,
  estimateRemainingMs,
  faceCount,
  finishedCount,
  formatRemaining,
  liveTotal,
  progressValueText,
  runningSyncHint,
  type BulkSyncLiveProgress
} from "./bulk-sync-progress";
import type { BulkSyncProgressStore, LastBulkSyncRun } from "./useBulkSyncRun";
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

/**
 * Why each Add menu entry is unavailable, or nothing when it is available.
 *
 * Clone and Fork no longer wait for a folder: with none, their destination
 * step offers to create one (design/New User Journey - UX Review, card 5a).
 * Only Rescan still needs a folder to rescan.
 */
export function addMenuReasons(input: {
  hasProfile: boolean;
  rootCount: number;
}): {
  find?: string;
  addFolders?: string;
  rescan?: string;
  clone?: string;
  fork?: string;
} {
  if (!input.hasProfile) {
    const reason = "Load or create a profile first";
    return { find: reason, addFolders: reason, rescan: reason, clone: reason, fork: reason };
  }
  if (input.rootCount === 0) return { rescan: "Add a repo folder first" };
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
  /** The live run's progress, once it has reported. */
  progress?: BulkSyncLiveProgress | null;
}): {
  name: string;
  label: string;
  tooltip: string;
  count: number;
  /** "12/27" while a run is live; kept at the icon-only step. */
  liveCount?: string;
  /** The position in words, for `aria-description`: the name stays put. */
  description?: string;
} {
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
  if (input.busy) lines.push("Running now — click to open.");
  else if (input.lastAuto !== undefined) lines.push(input.lastAuto);
  const word = recent ? "recent" : "all";
  const face =
    input.verb === "pull"
      ? { name: `Try pull ${word}`, label: `Pull ${word}`, tooltip: lines.join(" "), count }
      : { name: `Fetch ${word} repos`, label: `Fetch ${word}`, tooltip: lines.join(" "), count };
  // While a run is live the face says how far along it is: "Pull recent
  // 12/27". The label keeps its words, so the accessible name still contains
  // it (SC 2.5.3) and E2E still finds the button; the position in words goes
  // in its description. design/Sync Progress on the Button - UX Review.dc.html, 2a.
  if (!input.busy || input.progress == null) return face;
  return {
    ...face,
    liveCount: faceCount(input.progress),
    description: progressValueText(input.progress.counts, liveTotal(input.progress))
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
 * The one row of profile-wide actions above the lens row: Add ▾ (Find
 * repositories, Add folders, Rescan folders, Clone, Fork), the sync button,
 * and Repository maintenance as a wrench.
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
  syncProgress = null,
  syncAuto = false,
  lastAutoRun,
  lastRun = null,
  tagCheckAfterSync = null,
  onToggleTagCheck,
  onAddFolder,
  onFindRepositories,
  onRescanFolders,
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
  /** The live run's progress, from the run's own fold. */
  syncProgress?: BulkSyncLiveProgress | null;
  /** The live run was started by the timer. */
  syncAuto?: boolean;
  lastAutoRun?: string | undefined;
  /** The newest finished run, for Sync options → Show last run. */
  lastRun?: LastBulkSyncRun | null;
  /** Show the run going now, or the last one's results. */
  onShowRun?: () => void;
  /** `general.tagCheckAfterSync`; null until the setting has been read. */
  tagCheckAfterSync?: boolean | null;
  onToggleTagCheck?: (on: boolean) => void;
  onAddFolder: () => void;
  /** Find my repositories: search the home folder for folders to add. */
  onFindRepositories?: (() => void) | undefined;
  /** Look through the profile's folders again now, past the daily scan. */
  onRescanFolders?: (() => void) | undefined;
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
  // Opening a modal blurs this button, and closing it returns focus here.
  // That return is part of the click that opened Maintenance, not a fresh
  // keyboard request for the hover card.
  const suppressMaintenanceFocusRef = useRef(false);
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
    lastAuto: lastAutoRun,
    progress: syncProgress
  });
  // While a run is live the hover card draws the run, not the setup; it is
  // replaced in place as reports arrive, so it never blinks.
  const faceTip: ReactNode =
    syncBusy && syncProgress !== null ? (
      <SyncRunCard
        progress={syncProgress}
        verb={syncVerb}
        scope={syncScope}
        interval={fetchInterval}
        auto={syncAuto}
      />
    ) : (
      face.tooltip
    );
  const faceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Only while the card on screen is the face's: the toolbar's buttons
    // share one tooltip, and a remembered "hovered" flag outlived the card
    // when focus moved to the wrench under a resting pointer.
    const el = faceRef.current;
    if (el !== null && (el.matches(":hover") || el === document.activeElement)) {
      tip.update(faceTip);
    }
    // `faceTip` is a new element every render; its inputs are what change.
  }, [syncBusy, syncProgress, face.tooltip, syncAuto]);
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
    // What a sync does besides fetching. Every Fetch and Pull obeys it:
    // this face, the timer, and a repository's own Fetch or Pull.
    ...(tagCheckAfterSync === null
      ? []
      : [
          {
            type: "item",
            label: "Check tags after sync",
            hint: "Compares with the published remote, at most hourly. Never changes a tag.",
            checked: tagCheckAfterSync,
            keepOpen: true,
            onSelect: () => onToggleTagCheck?.(!tagCheckAfterSync)
          } satisfies MenuItem,
          { type: "sep" } satisfies MenuItem
        ]),
    // A timed run raises no toast, and a finished toast leaves: this is how
    // either is read afterwards. It opens the dialog, so the menu closes.
    syncBusy
      ? {
          type: "item",
          label: "Show the running sync",
          inset: true,
          ...(syncProgress === null
            ? {}
            : {
                hint: runningSyncHint(
                  syncProgress,
                  syncAuto,
                  formatElapsed(Math.max(0, Date.now() - syncProgress.startedAt))
                )
              }),
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
  const maintenanceTooltip = hoverTooltip(
    tip,
    "Repository maintenance… — collect Git garbage, prune finished worktrees, and review leftover local branches"
  );

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
          ref={faceRef}
          type="button"
          className="sidebar-toolbar__btn sidebar-toolbar__sync"
          aria-label={face.name}
          aria-description={face.description}
          aria-busy={syncBusy}
          disabled={!hasProfile || face.count === 0}
          {...hoverTooltip(tip, faceTip)}
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
          {face.liveCount !== undefined && (
            <span className="sidebar-toolbar__count" data-fit-text-columns={face.liveCount.length}>
              {face.liveCount}
            </span>
          )}
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
        {syncBusy && syncProgress !== null && (
          <OutcomeBar
            className="sidebar-toolbar__progress"
            fitOverlay
            counts={syncProgress.counts}
            inFlight={syncProgress.inFlight}
            queued={syncProgress.queued}
          />
        )}
      </div>
      <button
        ref={lastRef}
        type="button"
        className="sidebar-toolbar__btn sidebar-toolbar__icon"
        aria-label="Repository maintenance…"
        disabled={!hasProfile}
        {...maintenanceTooltip}
        onFocus={(event) => {
          if (suppressMaintenanceFocusRef.current) {
            suppressMaintenanceFocusRef.current = false;
            tip.hide();
            return;
          }
          maintenanceTooltip.onFocus(event);
        }}
        onClick={() => {
          suppressMaintenanceFocusRef.current = true;
          tip.hide();
          onMaintenance();
        }}
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
            // Stays for good: it is also how someone with twelve folders
            // finds the thirteenth (card 4d).
            item("Find repositories…", reasons.find, () => onFindRepositories?.()),
            item("Add folders…", reasons.addFolders, onAddFolder),
            item("Rescan folders", reasons.rescan, () => onRescanFolders?.()),
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

/**
 * The sync button's hover card while a run is live: what it is doing, how
 * far along, what went wrong so far, and that a click opens it. A tooltip,
 * with no controls, so nothing has to be chased with the pointer; the face
 * itself opens the dialog. design/Sync Progress on the Button - UX
 * Review.dc.html, 3a.
 */
export function SyncRunCard({
  progress,
  verb,
  scope,
  interval,
  auto
}: {
  progress: BulkSyncLiveProgress;
  verb: SyncVerb;
  scope: FetchScope;
  interval: FetchInterval;
  auto: boolean;
}): ReactElement {
  const now = useSecondsClock(true);
  const elapsed = Math.max(0, now - progress.startedAt);
  const finished = finishedCount(progress.counts);
  const total = liveTotal(progress);
  const remaining = estimateRemainingMs(elapsed, finished, total);
  const every = fetchIntervalPhrase(interval);
  const title = `${verb === "pull" ? "Pulling" : "Fetching"} ${
    scope === "recent" ? "the Focused list" : "every repository"
  }`;
  const footer = [
    auto ? `Automatic${every === null ? "" : ` · ${every}`}` : "Started by you",
    remaining === null ? null : formatRemaining(remaining),
    "Click to open"
  ].filter((part) => part !== null);
  return (
    <span className="sync-run-card">
      <span className="sync-run-card__head">
        <strong>{title}</strong>
        <span className="sync-run-card__clock">{formatElapsed(elapsed)}</span>
      </span>
      <OutcomeBar
        className="sync-run-card__bar"
        counts={progress.counts}
        inFlight={progress.inFlight}
        queued={progress.queued}
      />
      <span className="sync-run-card__counts">
        <span>
          <strong>{finished}</strong> of {total}
        </span>
        {BULK_SYNC_OUTCOMES.filter((outcome) => progress.counts[outcome] > 0).map(
          (outcome) => (
            <span key={outcome} className={`sync-run-card__count is-${outcome}`}>
              <strong>{progress.counts[outcome]}</strong> {outcome}
            </span>
          )
        )}
        {progress.inFlight > 0 && <span>{progress.inFlight} running</span>}
        {progress.queued > 0 && <span>{progress.queued} queued</span>}
      </span>
      {progress.path !== null && (
        <span className="sync-run-card__path">{progress.path}</span>
      )}
      <span className="sync-run-card__foot">{footer.join(" · ")}</span>
    </span>
  );
}

/**
 * The toolbar with the live run's progress read from its store, so a
 * progress report re-renders this row and not the whole sidebar.
 */
export function LiveSidebarToolbar({
  progressStore,
  ...props
}: Omit<Parameters<typeof SidebarToolbar>[0], "syncProgress"> & {
  progressStore: BulkSyncProgressStore;
}): ReactElement {
  const progress = useSyncExternalStore(progressStore.subscribe, progressStore.get);
  return <SidebarToolbar {...props} syncProgress={progress} />;
}
