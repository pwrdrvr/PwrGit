import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { Repo, Worktree, WorktreeSort } from "@pwrgit/shared";
import { orderWorktrees, reorder, SORT_LABEL } from "./repo-view";
import { PinIcon, WorktreeRow } from "./WorktreeRow";

export function RepoRow({
  repo,
  expanded,
  containsSelection,
  selectedWorktreeId,
  selectedIds,
  sort,
  customOrder,
  onToggleExpand,
  onToggleRepoPin,
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
  onToggleExpand: () => void;
  onToggleRepoPin: () => void;
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

  const behind = repo.worktrees.reduce((m, w) => Math.max(m, w.behind), 0);
  const ordered = orderWorktrees(repo.worktrees, sort, customOrder);
  const orderedIds = ordered.map((w) => w.id);
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
          <div className="wt-section__head">
            <span className="wt-section__label">Worktrees</span>
            <span style={{ flex: 1 }} />
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
              onSelect={(e) => onSelectWorktree(w, e, orderedIds)}
              onContextMenu={(e) => onContextWorktree(w, e, orderedIds)}
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
