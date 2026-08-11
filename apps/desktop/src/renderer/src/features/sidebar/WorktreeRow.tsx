import {
  useEffect,
  useRef,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { Worktree } from "@pwrgit/shared";
import { WorktreeMenu } from "../shell/WorktreeMenu";
import { PrChip } from "./PrChip";
import { isPrunableWorktree, relativeAge, type DropPosition } from "./repo-view";

const PR_HOVER_PREFETCH_DELAY_MS = 750;

export function WorktreeRow({
  worktree,
  selected,
  multiSelected,
  now,
  onSelect,
  onContextMenu,
  onTogglePin,
  onRemove,
  onRefreshPullRequest,
  dragProps,
  dragging,
  dropPosition,
  focusable,
  onKeyDown,
  onFocus
}: {
  worktree: Worktree;
  selected: boolean;
  multiSelected: boolean;
  now: number;
  onSelect: (e: ReactMouseEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onTogglePin: () => void;
  onRemove: () => void;
  /** Refresh this branch's PR after deliberate row hover. */
  onRefreshPullRequest?: () => void;
  /** Drag handlers from useListReorder; `draggable: false` for the primary. */
  dragProps: {
    draggable: boolean;
    onDragStart?: (e: DragEvent) => void;
    onDragOver?: (e: DragEvent) => void;
    onDragLeave?: (e: DragEvent) => void;
    onDrop?: (e: DragEvent) => void;
    onDragEnd?: (e: DragEvent) => void;
  };
  /** This row is the drag source (dim it so the insertion line reads). */
  dragging: boolean;
  /** Draw the insertion line on this side of the row, or nowhere. */
  dropPosition: DropPosition | null;
  /** The one row in this list that holds the tab stop (roving tabindex). */
  focusable: boolean;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onFocus: () => void;
}) {
  const prunable = isPrunableWorktree(worktree, now);
  const defaultBranch = worktree.defaultBranch || "default branch";
  const prHoverTimer = useRef<number | undefined>(undefined);
  const clearPrHoverTimer = (): void => {
    if (prHoverTimer.current !== undefined) {
      window.clearTimeout(prHoverTimer.current);
      prHoverTimer.current = undefined;
    }
  };
  const prefetchPullRequest = (): void => {
    if (onRefreshPullRequest === undefined) return;
    clearPrHoverTimer();
    prHoverTimer.current = window.setTimeout(() => {
      prHoverTimer.current = undefined;
      onRefreshPullRequest();
    }, PR_HOVER_PREFETCH_DELAY_MS);
  };
  useEffect(() => clearPrHoverTimer, []);
  // `role="treeitem"`, not `option`: these rows live inside the sidebar's
  // `role="tree"`, and `option` is only meaningful inside a listbox. Level 2
  // puts them under their repo, which the flat DOM can't otherwise convey.
  return (
    <div
      className={`wt-row${selected ? " is-selected" : ""}${
        multiSelected ? " is-multiselected" : ""
      }${prunable ? " is-stale" : ""}${dragging ? " is-dragging" : ""}${
        dropPosition === null ? "" : ` is-drop-${dropPosition}`
      }`}
      data-wt-id={worktree.id}
      role="treeitem"
      aria-selected={selected}
      aria-level={2}
      tabIndex={focusable ? 0 : -1}
      {...dragProps}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onContextMenu={onContextMenu}
      onMouseEnter={prefetchPullRequest}
      onMouseLeave={clearPrHoverTimer}
    >
      {/* The primary checkout is fixed at the top — no drag handle. */}
      <span
        className="wt-row__handle"
        aria-hidden="true"
        title={
          worktree.isPrimary
            ? undefined
            : "Drag to reorder — or ⌘⇧↑ / ⌘⇧↓ from the keyboard"
        }
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
          aria-label="Primary checkout"
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
          title="The repository's primary working tree"
        >
          primary
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
                className="wt-tag wt-tag--default-ahead"
                title={`${defaultBranch} has ${worktree.behindDefault} commits not in ${worktree.branch}; this is not commits available to pull`}
              >
                {defaultBranch} +{worktree.behindDefault}
              </span>
            )}
        </>
      )}
      {worktree.lastActivityAt !== undefined && (
        <span className="wt-age" title={worktree.lastActivityAt}>
          {relativeAge(worktree.lastActivityAt, now)}
        </span>
      )}
      {/* Only the pin star floats over the right edge on hover (it overlays
          the age); removal lives in the kebab so the PR chip and status tags
          never have to hide to make room. The kebab keeps its slot. */}
      <div className="wt-row__hoveracts">
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
      <WorktreeMenu
        worktree={worktree}
        className="wt-row__menu"
        {...(worktree.isPrimary ? {} : { onRemove })}
      />
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
