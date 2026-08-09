import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { Repo, Worktree, WorktreeSort } from "@pwrgit/shared";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  groupWorktreesForNavigation,
  reorder,
  repoPinSource,
  repoPrimaryBehind,
  SORT_LABEL,
  type DropPosition
} from "./repo-view";
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
  isPostDragClick
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
    e: ReactMouseEvent,
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
      return stored === null ? pinned.length === 0 : stored !== "0";
    } catch {
      return pinned.length === 0;
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
  const wtCount = repo.worktrees.length;
  const activeCollapsed = containsSelection && !expanded;

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
      onReorder(
        reorder(
          orderedIds,
          worktree.id,
          neighbor,
          event.key === "ArrowUp" ? "before" : "after"
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
      onSelectWorktree(
        worktree,
        event as unknown as ReactMouseEvent,
        displayIds
      );
    }
  };

  const renderWorktree = (worktree: Worktree) => (
    <WorktreeRow
      key={worktree.id}
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

  return (
    <div className="repo-block">
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
        <svg
          className={`repo-row__icon${containsSelection ? " is-active" : ""}`}
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        <span className="repo-row__name">{repo.name}</span>
        {behind > 0 && <span className="badge badge--warn">↓{behind}</span>}
        <span className="repo-row__wtcount">
          {wtCount} {wtCount === 1 ? "wt" : "wts"}
        </span>
        {/* Present only via a pinned worktree: the repo's own star is unlit, so
            without this marker the row looks like it doesn't belong in the
            Pinned lens it's sitting in. */}
        {pinSource === "worktree" && (
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
        <div className="wt-section">
          <div className="wt-section__elevated">
            {primary !== undefined && renderWorktree(primary)}
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
              <span className="wt-section__label">Worktrees</span>
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
              disabled={refreshing}
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
            <button
              className="sort-cycle"
              onClick={(e) => {
                e.stopPropagation();
                onCycleSort();
              }}
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
