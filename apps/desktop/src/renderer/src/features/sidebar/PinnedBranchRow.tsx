import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LocalBranchSummary } from "@pwrgit/shared";
import { relativeAge } from "../../lib/relativeAge";
import {
  hoverTooltip,
  truncatedTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { PinIcon } from "./WorktreeRow";

/** The row id a pinned branch takes in its repo's roving list, beside the
 *  worktree ids. Git refuses a colon in a ref name, so no branch can make this
 *  id read as a worktree's. */
export const pinnedBranchRowId = (branch: string): string => `branch:${branch}`;

/** What the meta line says about the branch against the one it tracks. */
function trackingWords(branch: LocalBranchSummary): string {
  switch (branch.tracking) {
    case "up_to_date":
      return "up to date";
    case "ahead":
      return `↑${branch.ahead}`;
    case "behind":
      return `↓${branch.behind}`;
    case "diverged":
      return `↓${branch.behind} ↑${branch.ahead}`;
    case "unpublished":
      return "local only";
    case "upstream_missing":
      return "gone";
  }
}

/**
 * A pinned branch that no worktree holds, in the repo's Pinned group.
 *
 * It looks like the worktree rows around it (same icon, name and hover star) so
 * the group reads as one shelf, and says what it is on a muted line beneath
 * the name — "no worktree", then the tracking count and the tip's age, the
 * order a worktree row's folder line and badges take (Post-ship 3a). The
 * count and age come from the ref listing the Branches section already
 * loads (`summary`); until it answers, the line says "no worktree" alone.
 * Activating it — click, Enter or Space — opens New worktree on the branch,
 * which is what picking the same branch in ⌘K does. Once a worktree exists the
 * pin belongs to that worktree's row and this one goes away.
 *
 * Nothing here drags and there is no kebab, so the row draws neither the
 * grip's `cursor: grab` nor the lane a kebab would take.
 */
export function PinnedBranchRow({
  branch,
  summary,
  now,
  posinset,
  setsize,
  focusable,
  onOpen,
  onUnpin,
  onKeyDown,
  onFocus
}: {
  branch: string;
  /** The branch in the repo's ref listing, once that has loaded. */
  summary?: LocalBranchSummary | undefined;
  now: number;
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
      <span className="wt-row__lead" aria-hidden="true" />
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
      <span
        className="wt-row__branch"
        {...truncatedTooltip(tip, branch)}
      >
        {branch}
      </span>
      {/* aria-hidden: the row's label already says "no worktree". */}
      <span className="wt-row__folder wt-row__meta" aria-hidden="true">
        <span className="wt-row__folder-name">
          no worktree
          {summary !== undefined && (
            <>
              {" · "}
              <span
                className={
                  summary.tracking === "behind" || summary.tracking === "diverged"
                    ? "wt-row__meta-behind"
                    : undefined
                }
              >
                {trackingWords(summary)}
              </span>
              {summary.lastCommitAt !== undefined &&
                ` · ${relativeAge(summary.lastCommitAt, now)}`}
            </>
          )}
        </span>
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
