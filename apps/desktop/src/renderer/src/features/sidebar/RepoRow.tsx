import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { Repo, Worktree, WorktreeSort } from "@pwrgit/shared";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  orderWorktrees,
  reorder,
  repoPrimaryBehind,
  SORT_LABEL
} from "./repo-view";
import { PinIcon, WorktreeRow } from "./WorktreeRow";

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
  onRemoveSelected,
  onClearSelected,
  onCycleSort,
  onReorder,
  onNewWorktree
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
  onRemoveSelected: () => void;
  onClearSelected: () => void;
  onCycleSort: () => void;
  onReorder: (orderedIds: string[]) => void;
  onNewWorktree: () => void;
}) {
  const dragId = useRef<string | null>(null);
  const refreshTooltip = useViewportTooltip();

  const behind = repoPrimaryBehind(repo);
  const primary = repo.worktrees.find((w) => w.isPrimary);
  const linked = repo.worktrees.filter((w) => !w.isPrimary);
  const ordered = orderWorktrees(linked, sort, customOrder);
  const orderedIds = ordered.map((w) => w.id);
  // Selection ranges (⇧-click) span the local checkout + worktrees in display
  // order; drag reordering only touches the linked worktrees (orderedIds).
  const displayIds =
    primary === undefined ? orderedIds : [primary.id, ...orderedIds];
  const wtCount = repo.worktrees.length;
  const activeCollapsed = containsSelection && !expanded;

  return (
    <div className="repo-block">
      <div
        className={`repo-row${activeCollapsed ? " is-active" : ""}`}
        onClick={onToggleExpand}
      >
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
        <span
          className={`pin${repo.pinned ? " is-pinned" : ""}`}
          title="Pin repo"
          onClick={(e) => {
            e.stopPropagation();
            onToggleRepoPin();
          }}
        >
          <PinIcon filled={repo.pinned} size={12} />
        </span>
      </div>

      {expanded && (
        <div className="wt-section">
          {primary !== undefined && (
            <WorktreeRow
              key={primary.id}
              worktree={primary}
              selected={primary.id === selectedWorktreeId}
              multiSelected={selectedIds.has(primary.id)}
              now={now}
              onSelect={(e) => onSelectWorktree(primary, e, displayIds)}
              onContextMenu={(e) => onContextWorktree(primary, e, displayIds)}
              onTogglePin={() =>
                onToggleWorktreePin(primary.id, !primary.pinned)
              }
              onRemove={() => onRemoveWorktree(primary.id)}
              onDragStart={() => undefined}
              onDragOver={() => undefined}
              onDrop={() => undefined}
              onDragEnd={() => undefined}
            />
          )}

          <div className="wt-section__head">
            <span className="wt-section__label">Worktrees</span>
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

          {selectedIds.size > 1 && (
            <div className="wt-selbar">
              <span className="wt-selbar__count">
                {selectedIds.size} selected
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="wt-selbar__btn wt-selbar__btn--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveSelected();
                }}
              >
                Remove
              </button>
              <button
                className="wt-selbar__btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearSelected();
                }}
              >
                Clear
              </button>
            </div>
          )}

          {ordered.map((w) => (
            <WorktreeRow
              key={w.id}
              worktree={w}
              selected={w.id === selectedWorktreeId}
              multiSelected={selectedIds.has(w.id)}
              now={now}
              onSelect={(e) => onSelectWorktree(w, e, displayIds)}
              onContextMenu={(e) => onContextWorktree(w, e, displayIds)}
              onTogglePin={() => onToggleWorktreePin(w.id, !w.pinned)}
              onRemove={() => onRemoveWorktree(w.id)}
              onDragStart={() => {
                dragId.current = w.id;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const d = dragId.current;
                if (d !== null) onReorder(reorder(orderedIds, d, w.id));
                dragId.current = null;
              }}
              onDragEnd={() => {
                dragId.current = null;
              }}
            />
          ))}

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
    </div>
  );
}
