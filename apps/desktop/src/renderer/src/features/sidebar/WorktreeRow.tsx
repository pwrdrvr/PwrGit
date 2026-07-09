import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import type { Worktree } from "@pwrgit/shared";
import { WorktreeMenu } from "../shell/WorktreeMenu";
import { PrChip } from "./PrChip";
import { isPrunableWorktree, relativeAge } from "./repo-view";

export function WorktreeRow({
  worktree,
  selected,
  multiSelected,
  onSelect,
  onContextMenu,
  onTogglePin,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  worktree: Worktree;
  selected: boolean;
  multiSelected: boolean;
  onSelect: (e: ReactMouseEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const prunable = isPrunableWorktree(worktree);
  return (
    <div
      className={`wt-row${selected ? " is-selected" : ""}${
        multiSelected ? " is-multiselected" : ""
      }${prunable ? " is-stale" : ""}`}
      data-wt-id={worktree.id}
      draggable={!worktree.isPrimary}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      {/* The local checkout is fixed at the top — no drag handle. */}
      <span
        className="wt-row__handle"
        title={worktree.isPrimary ? undefined : "Drag to reorder"}
      >
        {!worktree.isPrimary && (
          <svg width="9" height="14" viewBox="0 0 9 14" fill="currentColor">
            <circle cx="2" cy="2" r="1.3" />
            <circle cx="7" cy="2" r="1.3" />
            <circle cx="2" cy="7" r="1.3" />
            <circle cx="7" cy="7" r="1.3" />
            <circle cx="2" cy="12" r="1.3" />
            <circle cx="7" cy="12" r="1.3" />
          </svg>
        )}
      </span>
      {worktree.isPrimary ? (
        <svg
          className="wt-row__branch-icon wt-row__branch-icon--local"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label="Local checkout"
        >
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V20h14V9.5" />
        </svg>
      ) : (
        <svg
          className="wt-row__branch-icon"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 3v12" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="6" r="3" />
          <path d="M18 9c0 6-6 6-6 12" />
        </svg>
      )}
      <span className="wt-row__branch" title={worktree.branch}>
        {worktree.branch}
      </span>
      {worktree.isPrimary && (
        <span
          className="wt-tag wt-tag--local"
          title="The repo's local checkout (primary working tree)"
        >
          local
        </span>
      )}
      {worktree.dirty > 0 && (
        <span className="badge badge--warn">●{worktree.dirty}</span>
      )}
      {worktree.ahead > 0 && (
        <span className="badge-text badge-text--ok">↑{worktree.ahead}</span>
      )}
      {worktree.behind > 0 && (
        <span className="badge-text badge-text--warn">↓{worktree.behind}</span>
      )}
      {worktree.pr !== undefined && !worktree.isDefaultBranch ? (
        <PrChip pr={worktree.pr} />
      ) : (
        <>
          {!worktree.isDefaultBranch && worktree.mergedIntoDefault && (
            <span
              className="wt-tag wt-tag--merged"
              title="Contained in the default branch by ancestry — not necessarily a merged PR (squash/rebase merges won't show here)"
            >
              in default
            </span>
          )}
          {!worktree.isDefaultBranch && worktree.divergedFromDefault && (
            <span
              className="wt-tag wt-tag--diverged"
              title="No shared history with the default branch (rewritten or orphaned)"
            >
              diverged
            </span>
          )}
          {!worktree.isDefaultBranch &&
            !worktree.mergedIntoDefault &&
            !worktree.divergedFromDefault &&
            worktree.behindDefault > 0 && (
              <span
                className="wt-tag wt-tag--behind"
                title={`${worktree.behindDefault} commits behind the default branch`}
              >
                ↓{worktree.behindDefault}
              </span>
            )}
        </>
      )}
      {worktree.lastActivityAt !== undefined && (
        <span className="wt-age" title={worktree.lastActivityAt}>
          {relativeAge(worktree.lastActivityAt)}
        </span>
      )}
      {/* Trash + pin toggle reserve no space at rest — they float over the row's
          right edge on hover only (pinned state reads from sort order + the
          section's "Pinned" badge, as in PwrAgnt). The kebab keeps its slot. */}
      <div className="wt-row__hoveracts">
        {!worktree.isPrimary && (
          <button
            type="button"
            className="wt-remove"
            title="Remove worktree"
            aria-label="Remove worktree"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`pin${worktree.pinned ? " is-pinned" : ""}`}
          title={worktree.pinned ? "Unpin worktree" : "Pin worktree"}
          aria-label={worktree.pinned ? "Unpin worktree" : "Pin worktree"}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
        >
          <PinIcon filled={worktree.pinned} size={11} />
        </button>
      </div>
      <WorktreeMenu worktree={worktree} className="wt-row__menu" />
    </div>
  );
}

export function PinIcon({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    >
      <path d="M12 2 15 9 22 9.3 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.3 9 9Z" />
    </svg>
  );
}
