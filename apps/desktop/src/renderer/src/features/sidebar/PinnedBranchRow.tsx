import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { PinIcon } from "./WorktreeRow";

/** The row id a pinned branch takes in its repo's roving list, beside the
 *  worktree ids. Git refuses a colon in a ref name, so no branch can make this
 *  id read as a worktree's. */
export const pinnedBranchRowId = (branch: string): string => `branch:${branch}`;

/**
 * A pinned branch that no worktree holds, in the repo's Pinned group.
 *
 * It looks like the worktree rows around it (same icon, name and hover star) so
 * the group reads as one shelf, and says what it is with a `branch` tag: there
 * is no checkout behind it, so nothing here can be dirty, ahead or behind.
 * Activating it — click, Enter or Space — opens New worktree on the branch,
 * which is what picking the same branch in ⌘K does. Once a worktree exists the
 * pin belongs to that worktree's row and this one goes away.
 */
export function PinnedBranchRow({
  branch,
  posinset,
  setsize,
  focusable,
  onOpen,
  onUnpin,
  onKeyDown,
  onFocus
}: {
  branch: string;
  posinset: number;
  setsize: number;
  focusable: boolean;
  onOpen: () => void;
  onUnpin: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  onFocus: () => void;
}) {
  const tip = useViewportTooltip();
  return (
    <div
      className="wt-row wt-row--branch"
      data-wt-id={pinnedBranchRowId(branch)}
      role="treeitem"
      aria-selected={false}
      aria-level={2}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-label={`${branch}, pinned branch, no worktree. Enter opens a worktree for it.`}
      tabIndex={focusable ? 0 : -1}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <span className="wt-row__handle" aria-hidden="true" />
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
        aria-hidden="true"
      >
        <path d="M6 3v12" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="6" r="3" />
        <path d="M18 9c0 6-6 6-6 12" />
      </svg>
      <span className="wt-row__branch" {...hoverTooltip(tip, branch)}>
        {branch}
      </span>
      <span
        className="wt-tag wt-tag--branch"
        aria-hidden="true"
        {...hoverTooltip(tip, "Pinned branch — no worktree has it checked out")}
      >
        branch
      </span>
      <div className="wt-row__hoveracts">
        <button
          type="button"
          className="pin is-pinned"
          aria-label={`Unpin branch ${branch}`}
          {...hoverTooltip(tip, "Unpin branch")}
          onClick={(e) => {
            e.stopPropagation();
            onUnpin();
          }}
        >
          <PinIcon filled size={11} />
        </button>
      </div>
      {tip.tooltipNode}
    </div>
  );
}
