import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { Repo, Worktree, WorktreeSort } from "@pwrgit/shared";
import { announce, movedMessage } from "../../lib/announce";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  groupWorktreesForNavigation,
  linkedWorktreeCount,
  reorder,
  repoPinSource,
  repoPrimaryBehind,
  SORT_LABEL,
  type DropPosition,
  type SelectionModifiers
} from "./repo-view";
import {
  identityDescription,
  RepoIdentityGlyphs
} from "./RepoIdentityMarks";
import { useListReorder } from "./useListReorder";
import { PinIcon, WorktreeRow } from "./WorktreeRow";
import { RepoRefsSections } from "./RepoRefsSections";

/** Distinguishes worktree drags from repo drags (see useListReorder). */
const WORKTREE_MIME = "application/x-pwrgit-worktree";

const REFRESH_WORKTREES_TOOLTIP =
  "Refresh this list — re-read Git for worktrees added, removed, or switched outside PwrGit (does not fetch)";

export function RepoRow({
  repo,
  expanded,
  containsSelection,
  selectedWorktreeId,
  selectedIds,
  sort,
  customOrder,
  now,
  onToggleExpand,
  onToggleRepoPin,
  refreshing,
  onRefreshWorktrees,
  onSelectWorktree,
  onContextWorktree,
  onToggleWorktreePin,
  onRemoveWorktree,
  onRefreshPullRequest,
  onRemoveSelected,
  onClearSelected,
  onCycleSort,
  onReorder,
  onNewWorktree,
  onRevealWorktree,
  onCreateWorktreeFromRef,
  arrangeable,
  dragProps,
  dragging,
  dropPosition,
  focusable,
  onRowKeyDown,
  onRowFocus,
  isPostDragClick,
  posinset,
  setsize
}: {
  repo: Repo;
  expanded: boolean;
  containsSelection: boolean;
  selectedWorktreeId: string | null;
  selectedIds: Set<string>;
  sort: WorktreeSort;
  customOrder: string[] | undefined;
  now: number;
  onToggleExpand: () => void;
  onToggleRepoPin: () => void;
  refreshing: boolean;
  onRefreshWorktrees: () => void;
  onSelectWorktree: (
    worktree: Worktree,
    e: SelectionModifiers,
    orderedIds: string[]
  ) => void;
  onContextWorktree: (
    worktree: Worktree,
    e: ReactMouseEvent,
    orderedIds: string[]
  ) => void;
  onToggleWorktreePin: (worktreeId: string, pinned: boolean) => void;
  onRemoveWorktree: (worktreeId: string) => void;
  onRefreshPullRequest: (branch: string) => void;
  onRemoveSelected: () => void;
  onClearSelected: () => void;
  onCycleSort: () => void;
  onReorder: (orderedIds: string[]) => void;
  onNewWorktree: () => void;
  onRevealWorktree: (worktreeId: string) => void;
  onCreateWorktreeFromRef: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => void;
  /** The current lens is one the user can arrange by hand (Pinned only). */
  arrangeable: boolean;
  /** Repo-level drag handlers from the sidebar's useListReorder. */
  dragProps: {
    draggable: boolean;
    onDragStart?: (e: DragEvent) => void;
    onDragOver?: (e: DragEvent) => void;
    onDragLeave?: (e: DragEvent) => void;
    onDrop?: (e: DragEvent) => void;
    onDragEnd?: (e: DragEvent) => void;
  };
  dragging: boolean;
  dropPosition: DropPosition | null;
  focusable: boolean;
  onRowKeyDown: (e: ReactKeyboardEvent) => void;
  onRowFocus: () => void;
  /** True while the synthetic click that follows a drop is still arriving. */
  isPostDragClick: () => boolean;
  /** 1-based position of this row among the treeitems it is listed with. */
  posinset: number;
  /** How many treeitems that list holds. */
  setsize: number;
}) {
  const refreshTooltip = useViewportTooltip();
  const { primary, pinned, remaining, displayIds } =
    groupWorktreesForNavigation(repo.worktrees, sort, customOrder);
  const orderedIds = [...pinned, ...remaining].map((worktree) => worktree.id);
  const [worktreesOpen, setWorktreesOpen] = useState(() => {
    try {
      const stored = window.localStorage.getItem(
        `pwrgit.unpinnedWorktreesOpen.${repo.id}`
      );
      return stored !== null && stored !== "0";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        `pwrgit.unpinnedWorktreesOpen.${repo.id}`,
        worktreesOpen ? "1" : "0"
      );
    } catch {
      // Ignore private-mode and quota failures.
    }
  }, [repo.id, worktreesOpen]);

  const lastSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedWorktreeId === null) {
      lastSelectedRef.current = null;
      return;
    }
    if (!remaining.some((worktree) => worktree.id === selectedWorktreeId)) {
      lastSelectedRef.current = null;
      return;
    }
    if (selectedWorktreeId === lastSelectedRef.current) return;
    lastSelectedRef.current = selectedWorktreeId;
    setWorktreesOpen(true);
  }, [remaining, selectedWorktreeId]);

  const behind = repoPrimaryBehind(repo);
  // Linked worktrees only — the primary is the repo's own checkout, not one of
  // them. A repo with none shows no count at all rather than "0 wts" on what is
  // typically most of the list.
  const wtCount = linkedWorktreeCount(repo);
  const activeCollapsed = containsSelection && !expanded;

  // The disclosure holds every linked worktree only when none are pinned. Once
  // some are, they render above it under their own heading, so the disclosure
  // says what it actually contains — and the two counts add up to the repo
  // row's total instead of silently disagreeing with it.
  const worktreesLabel = pinned.length > 0 ? "Other worktrees" : "Worktrees";

  // The primary checkout is fixed at the top, so it is neither a drag source
  // nor a drop target — `orderedIds` excludes it for the same reason.
  //
  // Pinned worktrees render in their own section above the disclosure, so a
  // drop across that boundary would reorder the flat list while the row visibly
  // snapped back into its own section. Keep the gesture inside one section:
  // moving a worktree between them is what the pin is for.
  const pinnedIds = new Set(pinned.map((worktree) => worktree.id));
  const wtDrag = useListReorder({
    mime: WORKTREE_MIME,
    canDrop: (dragged, targetId) =>
      pinnedIds.has(dragged) === pinnedIds.has(targetId),
    onCommit: (dragged, targetId, position) => {
      onReorder(reorder(orderedIds, dragged, targetId, position));
    }
  });

  // Roving tabindex within this repo's worktree list: one tab stop, arrows to
  // move between rows. Defaults to the selected row so tabbing in lands on the
  // row the user is actually looking at.
  const [focusedWtId, setFocusedWtId] = useState<string | null>(null);
  const tabStopId =
    focusedWtId !== null && displayIds.includes(focusedWtId)
      ? focusedWtId
      : selectedWorktreeId !== null && displayIds.includes(selectedWorktreeId)
        ? selectedWorktreeId
        : displayIds[0] ?? null;

  const focusWorktreeAt = (index: number): void => {
    const id = displayIds[index];
    if (id === undefined) return;
    setFocusedWtId(id);
    const el = document.querySelector<HTMLElement>(`[data-wt-id="${id}"]`);
    el?.focus();
  };

  const handleWorktreeKeyDown = (
    worktree: Worktree,
    event: ReactKeyboardEvent
  ): void => {
    // The pin and the kebab live inside this row, and their keydowns bubble
    // here. Handling them cancelled the button's own activation — see the note
    // on Sidebar's handleRepoKeyDown (SC 2.1.1).
    if (event.target !== event.currentTarget) return;
    const index = displayIds.indexOf(worktree.id);
    if (index === -1) return;
    // ⌘⇧↑/↓ moves the row; plain ↑/↓ moves the focus. Same modifier pair as
    // PwrAgnt's pinned-directory reorder, so the two apps stay one muscle
    // memory.
    if (event.metaKey && event.shiftKey) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (worktree.isPrimary) return;
      const from = orderedIds.indexOf(worktree.id);
      const to = from + (event.key === "ArrowUp" ? -1 : 1);
      const neighbor = orderedIds[to];
      // Same section boundary the drag honors (see `canDrop` above).
      if (
        from === -1 ||
        neighbor === undefined ||
        pinnedIds.has(neighbor) !== pinnedIds.has(worktree.id)
      ) {
        return;
      }
      event.preventDefault();
      const moved = reorder(
        orderedIds,
        worktree.id,
        neighbor,
        event.key === "ArrowUp" ? "before" : "after"
      );
      onReorder(moved);
      // Focus does not move, so without this the reorder is silent (SC 4.1.3).
      //
      // Count in the same terms as this row's aria-posinset, which is an index
      // into `displayIds`. `orderedIds` (and so `moved`) leaves the primary
      // checkout out — it is fixed at the top and cannot be reordered — so
      // announcing a raw index into it would tell the user "2 of 3" about a
      // row whose own aria-posinset reads "3 of 4". displayIds is
      // [primary?, ...pinned, ...remaining], so the primary is the whole
      // difference.
      const primaryOffset = primary === undefined ? 0 : 1;
      announce(
        movedMessage(
          worktree.branch,
          moved.indexOf(worktree.id) + 1 + primaryOffset,
          moved.length + primaryOffset
        )
      );
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusWorktreeAt(Math.min(index + 1, displayIds.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusWorktreeAt(Math.max(index - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectWorktree(worktree, event, displayIds);
    }
  };

  const renderWorktree = (worktree: Worktree) => (
    <WorktreeRow
      key={worktree.id}
      // `displayIds` is the group's treeitem order (primary, pinned, then the
      // rest) — the same list the arrow keys walk.
      posinset={displayIds.indexOf(worktree.id) + 1}
      setsize={displayIds.length}
      worktree={worktree}
      selected={worktree.id === selectedWorktreeId}
      multiSelected={selectedIds.has(worktree.id)}
      now={now}
      onSelect={(event) => {
        if (wtDrag.isPostDragClick()) return;
        onSelectWorktree(worktree, event, displayIds);
      }}
      onContextMenu={(event) =>
        onContextWorktree(worktree, event, displayIds)
      }
      onTogglePin={() =>
        onToggleWorktreePin(worktree.id, !worktree.pinned)
      }
      onRemove={() => onRemoveWorktree(worktree.id)}
      {...(worktree.isDefaultBranch
        ? {}
        : {
            onRefreshPullRequest: () =>
              onRefreshPullRequest(worktree.branch)
          })}
      dragProps={wtDrag.rowProps(worktree.id, !worktree.isPrimary)}
      dragging={wtDrag.dragId === worktree.id}
      dropPosition={
        wtDrag.target?.id === worktree.id ? wtDrag.target.position : null
      }
      focusable={tabStopId === worktree.id}
      onKeyDown={(event) => handleWorktreeKeyDown(worktree, event)}
      onFocus={() => setFocusedWtId(worktree.id)}
    />
  );

  const pinSource = repoPinSource(repo);
  const pinLabel = repo.pinned
    ? "Unpin repo"
    : pinSource === "worktree"
      ? "Pin repo (currently listed because a worktree is pinned)"
      : "Pin repo";

  // A treeitem owns its children by DOM nesting, but the worktree section is a
  // SIBLING of the repo row (the row is a sticky flex line; nesting the section
  // inside it would break the layout). `aria-owns` is the escape hatch for
  // exactly that case — without it the section reads as a group floating beside
  // the repo rather than under it.
  const worktreeGroupId = `wt-group-${repo.id}`;

  // `aria-label` pins the row's name to the repo name alone — every E2E step
  // helper resolves rows by that exact name, and it is the right name. But a
  // label REPLACES the name computed from contents, so the two things the row
  // also shows (its worktree count, and the behind badge) reached nobody using
  // a screen reader. A description carries them without touching the name.
  //
  // `aria-posinset` / `aria-setsize` for the same reason: the tree's DOM
  // children are not a clean run of treeitems. Folder buckets wrap them in
  // groups, every expanded repo drops a sibling wt-section between two rows,
  // and `aria-owns` re-parents that section under the row above it — so a
  // browser's implicit position is computed from a list that has holes in it.
  // State it instead.
  const describedById = `repo-desc-${repo.id}`;
  const description = [
    // Mirrors the visible count exactly, including its absence: `wtCount` is
    // LINKED worktrees, and a repo with none renders no badge at all rather
    // than "0 wts", so describing it as "0 worktrees" would announce a fact
    // the row deliberately stopped making.
    wtCount === 0
      ? null
      : wtCount === 1
        ? "1 linked worktree"
        : `${wtCount} linked worktrees`,
    behind > 0 ? `primary branch ${behind} behind upstream` : null,
    // The identity glyphs are aria-hidden and carry only titles, which are not
    // reliably announced — this is how they reach a screen reader at all.
    repo.identity === undefined ? null : identityDescription(repo.identity),
    arrangeable && pinSource === "worktree"
      ? "in Pinned because one of its worktrees is pinned"
      : null
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <div className="repo-block" role="presentation">
      <div
        className={`repo-row${activeCollapsed ? " is-active" : ""}${
          arrangeable ? " is-arrangeable" : ""
        }${dragging ? " is-dragging" : ""}${
          dropPosition === null ? "" : ` is-drop-${dropPosition}`
        }`}
        data-repo-id={repo.id}
        role="treeitem"
        aria-expanded={expanded}
        aria-label={repo.name}
        {...(description === "" ? {} : { "aria-describedby": describedById })}
        aria-level={1}
        aria-posinset={posinset}
        aria-setsize={setsize}
        {...(expanded ? { "aria-owns": worktreeGroupId } : {})}
        tabIndex={focusable ? 0 : -1}
        {...dragProps}
        onClick={() => {
          if (isPostDragClick()) return;
          onToggleExpand();
        }}
        onKeyDown={onRowKeyDown}
        onFocus={onRowFocus}
      >
        {/* Only the arrangeable lens gets a handle: everywhere else the list
            order is computed, so a grip would promise a gesture that has
            nowhere to persist to. */}
        {arrangeable && (
          <span
            className="repo-row__handle"
            aria-hidden="true"
            title="Drag to reorder — or ⌘⇧↑ / ⌘⇧↓ from the keyboard"
          >
            <svg width="9" height="14" viewBox="0 0 9 14" fill="currentColor">
              <circle cx="2" cy="2" r="1.3" />
              <circle cx="7" cy="2" r="1.3" />
              <circle cx="2" cy="7" r="1.3" />
              <circle cx="7" cy="7" r="1.3" />
              <circle cx="2" cy="12" r="1.3" />
              <circle cx="7" cy="12" r="1.3" />
            </svg>
          </span>
        )}
        <span className={`chev${expanded ? " is-open" : ""}`} />
        {/* No folder glyph. PwrAgnt's list mixes directories and threads, so
            its icon tells the two apart; this list is only ever repos, and a
            glyph on every row identifies nothing. The one signal it carried —
            "this repo holds the current selection" — moves to the name. */}
        {/* The name is the only thing in the row that can shrink, so at the
            240px minimum width and the largest text notch it ellipsises. The
            branch line below already carried a title for the same reason; this
            one did not, leaving the truncated text with no way to be read
            (SC 1.4.4's intent — no loss of content when text is enlarged). */}
        <span
          className={`repo-row__name${containsSelection ? " is-active" : ""}`}
          title={repo.name}
        >
          {repo.name}
        </span>
        {behind > 0 && <span className="badge badge--warn">↓{behind}</span>}
        {/* Forge marks sit between the name and the counts: they qualify the
            repository (what it is), where the counts describe its contents.
            Absent `identity` means "not looked up yet" and draws nothing —
            distinct from a read that came back `unknown`, which draws the
            dashed glyph. */}
        {repo.identity !== undefined && (
          <RepoIdentityGlyphs identity={repo.identity} />
        )}
        {wtCount > 0 && (
          <span className="repo-row__wtcount">
            {wtCount} {wtCount === 1 ? "wt" : "wts"}
          </span>
        )}
        {/* Rendered only when it says something. A repo with no linked
            worktrees, nothing behind and no borrowed pin has nothing to add
            beyond its name, and pointing aria-describedby at an empty element
            is worse than not describing it at all. */}
        {description !== "" && (
          <span id={describedById} className="a11y-sr-only">
            {description}
          </span>
        )}
        {/* Present only via a pinned worktree: the repo's own star is unlit, so
            without this marker the row looks like it doesn't belong in the
            Pinned lens it's sitting in. */}
        {arrangeable && pinSource === "worktree" && (
          <span
            className="repo-row__pin-via"
            title="In Pinned because one of its worktrees is pinned"
          >
            via wt
          </span>
        )}
        <button
          type="button"
          className={`pin${repo.pinned ? " is-pinned" : ""}`}
          title={pinLabel}
          aria-label={pinLabel}
          aria-pressed={repo.pinned}
          onClick={(e) => {
            e.stopPropagation();
            onToggleRepoPin();
          }}
        >
          <PinIcon filled={repo.pinned} size={12} />
        </button>
      </div>

      {expanded && (
        <div
          className="wt-section"
          id={worktreeGroupId}
          role="group"
          aria-label={`${repo.name} worktrees`}
        >
          <div className="wt-section__elevated">
            {primary !== undefined && renderWorktree(primary)}
            {/* Pinned worktrees sat here unlabelled, which is what made the
                disclosure below read "Worktrees 0" directly under two visible
                worktrees. Naming them accounts for the difference between this
                block and the one below, so both counts add up to the repo
                row's. */}
            {/* aria-hidden for the same reason .repo-group__head is: only
                treeitems and nested groups are valid content inside this
                `role="group"`, and a bare text node lands in the middle of the
                level-2 rows. Each pinned row already announces its state
                through its own "Unpin worktree" button. */}
            {pinned.length > 0 && (
              <div className="wt-subhead" aria-hidden="true">
                <span className="wt-section__label">Pinned</span>
                <span className="ref-section__count">{pinned.length}</span>
              </div>
            )}
            {pinned.map(renderWorktree)}
          </div>

          {selectedIds.size > 1 && (
            <div className="wt-selbar">
              <span className="wt-selbar__count">
                {selectedIds.size} selected
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="wt-selbar__btn wt-selbar__btn--danger"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveSelected();
                }}
              >
                Remove
              </button>
              <button
                className="wt-selbar__btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onClearSelected();
                }}
              >
                Clear
              </button>
            </div>
          )}

          <div className="wt-section__head">
            <button
              className="wt-section__toggle"
              aria-expanded={worktreesOpen}
              onClick={(event) => {
                event.stopPropagation();
                setWorktreesOpen((open) => !open);
              }}
            >
              <span className={`ref-section__chev${worktreesOpen ? " is-open" : ""}`} />
              <span className="wt-section__label">{worktreesLabel}</span>
              <span className="ref-section__count">{remaining.length}</span>
            </button>
            <span style={{ flex: 1 }} />
            {/* Scoped to this list on purpose: the same circular-arrows glyph
                means Fetch in the repo toolbar, so keep this one under the
                Worktrees heading where it can only read as "re-list these". */}
            <button
              type="button"
              className={`wt-refresh${refreshing ? " is-refreshing" : ""}`}
              aria-label={`Refresh worktrees for ${repo.name}`}
              aria-busy={refreshing}
              /* `disabled` (not `aria-disabled`) used to be set here the
                 instant the button was activated. Chromium blurs an element
                 the moment it becomes disabled, so activating this from the
                 keyboard threw focus back to <body> and the user lost their
                 place in the sidebar mid-refresh (SC 2.4.3). aria-disabled
                 conveys the same state without removing the element from the
                 focus order; the click handler below is what makes it inert. */
              aria-disabled={refreshing}
              onMouseEnter={(e) =>
                refreshTooltip.show(
                  e.currentTarget,
                  REFRESH_WORKTREES_TOOLTIP
                )
              }
              onMouseLeave={refreshTooltip.hide}
              onFocus={(e) =>
                refreshTooltip.show(
                  e.currentTarget,
                  REFRESH_WORKTREES_TOOLTIP
                )
              }
              onBlur={refreshTooltip.hide}
              onClick={(e) => {
                e.stopPropagation();
                if (refreshing) return;
                refreshTooltip.hide();
                onRefreshWorktrees();
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            </button>
            {refreshTooltip.tooltipNode}
            {/* The visible text is the current VALUE ("Recent"), which on its
                own named this button "Recent" — a name that says nothing about
                what activating it does (SC 4.1.2). The label states the action
                and still contains the visible string, so it also satisfies
                SC 2.5.3 Label in Name for speech input. */}
            <button
              className="sort-cycle"
              onClick={(e) => {
                e.stopPropagation();
                onCycleSort();
              }}
              aria-label={`${
                SORT_LABEL[customOrder !== undefined ? "custom" : sort]
              } — cycle worktree sort order`}
              title="Cycle worktree sort"
            >
              {SORT_LABEL[customOrder !== undefined ? "custom" : sort]}
            </button>
          </div>

          {worktreesOpen && (
            <div className="wt-section__body">
              {remaining.map(renderWorktree)}

              <button
                className="new-wt"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewWorktree();
                }}
              >
                <span className="new-wt__plus">+</span> New worktree
              </button>
            </div>
          )}

          <RepoRefsSections
            repo={repo}
            now={now}
            // Only when the working target lives in THIS repo. That is what
            // keeps the current-branch marker unique across the window while
            // "occupied" stays per-repo.
            focusedWorktree={
              repo.worktrees.find((w) => w.id === selectedWorktreeId) ?? null
            }
            onRevealWorktree={(worktreeId) => {
              setWorktreesOpen(true);
              onRevealWorktree(worktreeId);
            }}
            onCreateWorktree={onCreateWorktreeFromRef}
          />
        </div>
      )}
    </div>
  );
}
