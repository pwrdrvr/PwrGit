import { useState } from "react";
import { changeRequestMatch, type Repo, type Worktree } from "@pwrgit/shared";
import { shortWhen } from "../graph/graph-view";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { CopyTarget } from "../shell/CopyTarget";
import { PrChip } from "./PrChip";
import { RefRowActions, RefRowMenu } from "./RefRowMenu";
import { isFinishedWorktree, lastSegment } from "./repo-view";
import { PinIcon } from "./WorktreeRow";

/** The Worktrees tab's filter. The sidebar's Finished row opens it on
 *  `finished`, its View all on `all`. */
export type WorktreeStatusFilter = "inFlight" | "finished" | "all";

export const WORKTREE_STATUS_FILTERS: {
  value: WorktreeStatusFilter;
  label: string;
}[] = [
  { value: "inFlight", label: "In flight" },
  { value: "finished", label: "Finished" },
  { value: "all", label: "All" }
];

/** Every linked worktree, newest activity first — the primary checkout is the
 *  repository itself, not one of them. */
export function browserWorktrees(repo: Repo): Worktree[] {
  const time = (worktree: Worktree): number => {
    const at = Date.parse(worktree.lastActivityAt ?? "");
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  };
  return repo.worktrees
    .filter((worktree) => !worktree.isPrimary)
    .sort((a, b) => time(b) - time(a));
}

export function worktreeStatusCounts(
  worktrees: readonly Worktree[],
  now: number
): Record<WorktreeStatusFilter, number> {
  const finished = worktrees.filter((worktree) =>
    isFinishedWorktree(worktree, now)
  ).length;
  return {
    inFlight: worktrees.length - finished,
    finished,
    all: worktrees.length
  };
}

/** What a row's filter matches: branch, folder and path, and its change
 *  request through the same `changeRequestMatch` every refs tab uses. */
export function filterWorktrees(
  worktrees: readonly Worktree[],
  status: WorktreeStatusFilter,
  query: string,
  now: number
): Worktree[] {
  const q = query.trim().toLowerCase();
  return worktrees.filter((worktree) => {
    if (status !== "all") {
      const finished = isFinishedWorktree(worktree, now);
      if (finished !== (status === "finished")) return false;
    }
    if (q === "") return true;
    if (`${worktree.branch} ${worktree.path}`.toLowerCase().includes(q)) {
      return true;
    }
    return worktree.pr !== undefined && changeRequestMatch(worktree.pr, q) !== null;
  });
}

/** The Status cell: the one word that decides which bucket a row is in, or
 *  the counts that keep it in flight. */
export function worktreeStatusText(
  worktree: Worktree,
  now: number
): { label: string; tone: string } {
  if (worktree.missing === true) return { label: "Missing", tone: "missing" };
  if (isFinishedWorktree(worktree, now)) {
    return { label: "Finished", tone: "finished" };
  }
  const counts = [
    worktree.dirty > 0 ? `●${worktree.dirty}` : "",
    worktree.ahead > 0 ? `↑${worktree.ahead}` : "",
    worktree.behind > 0 ? `↓${worktree.behind}` : ""
  ].filter(Boolean);
  if (counts.length > 0) {
    return {
      label: counts.join(" "),
      tone: worktree.dirty > 0 ? "dirty" : "ahead"
    };
  }
  if (worktree.tracking === "unpublished") {
    return { label: "No upstream", tone: "unpublished" };
  }
  return { label: "In flight", tone: "in-flight" };
}

/** What an empty filtered tab says. */
const EMPTY_STATUS: Record<WorktreeStatusFilter, string> = {
  inFlight: "No worktrees are in flight.",
  finished: "No worktrees are finished.",
  all: "This repository has no linked worktrees."
};

/**
 * The refs browser's Worktrees tab: every linked worktree, the cap's two
 * buckets as filters, and the Finished view's one verb (design/Worktree List
 * Cap - UX Review.dc.html, 2d).
 *
 * Rows use the browser's own grid rather than the sidebar row, so the
 * browser's row keys (↑/↓, Space pins, Enter runs Show worktree) work here as
 * on every other tab.
 */
export function RepoWorktreeTable({
  worktrees,
  status,
  query,
  now,
  onRevealWorktree,
  onPruneWorktrees,
  onClose
}: {
  /** Already filtered — the tab's count and its rows read one list. */
  worktrees: Worktree[];
  status: WorktreeStatusFilter;
  query: string;
  now: number;
  onRevealWorktree: (worktreeId: string) => void;
  /** Absent, the Finished view still explains itself but offers no verb. */
  onPruneWorktrees?: (() => void) | undefined;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  // Optimistic, like the Branches tab's star: the row repaints at once and
  // settles when the tree's own update arrives.
  const [pinOverride, setPinOverride] = useState<Record<string, boolean>>({});
  const isPinned = (worktree: Worktree): boolean =>
    pinOverride[worktree.id] ?? worktree.pinned;
  const togglePin = async (worktree: Worktree): Promise<void> => {
    const pinned = !isPinned(worktree);
    setPinOverride((current) => ({ ...current, [worktree.id]: pinned }));
    const result = await dispatch("worktree:setPin", {
      worktreeId: worktree.id,
      pinned
    });
    if (!result.ok) {
      showErrorToast({
        title: `Couldn't ${pinned ? "pin" : "unpin"} ${worktree.branch}`,
        message: result.error.message,
        subject: { repoId: worktree.repoId }
      });
      setPinOverride((current) => {
        const { [worktree.id]: _failed, ...rest } = current;
        return rest;
      });
    }
  };
  const reveal = (worktree: Worktree): void => {
    onRevealWorktree(worktree.id);
    onClose();
  };

  return (
    <div className="refs-table refs-worktree-table">
      <div className="refs-table__header">
        <span>Worktree</span>
        <span>Folder</span>
        <span>Status</span>
        <span>Last commit</span>
        <span />
      </div>
      {worktrees.map((worktree) => {
        const folder = lastSegment(worktree.path);
        const state = worktreeStatusText(worktree, now);
        const pinned = isPinned(worktree);
        return (
          <div
            className={`refs-table__row${pinned ? " is-pinned" : ""}`}
            key={worktree.id}
            data-refs-row=""
            tabIndex={-1}
          >
            <div className="refs-table__identity">
              <span className="refs-pin-slot">
                <button
                  type="button"
                  data-refs-pin=""
                  className={`pin refs-pin${pinned ? " is-pinned" : ""}`}
                  aria-label={`${pinned ? "Unpin" : "Pin"} worktree ${worktree.branch}`}
                  aria-pressed={pinned}
                  {...hoverTooltip(tip, pinned ? "Unpin worktree" : "Pin worktree")}
                  onClick={() => void togglePin(worktree)}
                >
                  <PinIcon filled={pinned} size={11} />
                </button>
              </span>
              <span className="refs-branch-icon" aria-hidden="true">⑂</span>
              <div>
                <span className="refs-branch-name-line">
                  <CopyTarget
                    value={worktree.branch}
                    label={`Copy branch name ${worktree.branch}`}
                    hint={`${worktree.branch}\nClick to copy branch name`}
                    className="refs-copyable-name copyable"
                  >
                    <strong>{worktree.branch}</strong>
                  </CopyTarget>
                  {worktree.pr !== undefined && !worktree.isDefaultBranch && (
                    <PrChip pr={worktree.pr} />
                  )}
                </span>
                {worktree.pr !== undefined && <small>{worktree.pr.title}</small>}
              </div>
            </div>
            <CopyTarget
              value={worktree.path}
              label={`Copy path ${worktree.path}`}
              hint={`${worktree.path}\nClick to copy path`}
              className="refs-table__muted refs-copyable-upstream copyable"
            >
              <span className="refs-copyable-upstream__text">{folder}</span>
            </CopyTarget>
            <span className={`refs-status refs-status--wt-${state.tone}`}>
              {state.label}
            </span>
            <span className="refs-table__muted">
              {worktree.lastActivityAt === undefined
                ? "—"
                : shortWhen(worktree.lastActivityAt, now)}
            </span>
            <RefRowActions
              primary={
                <button
                  className="refs-row-action"
                  onClick={() => reveal(worktree)}
                >
                  Show worktree
                </button>
              }
              menu={
                <RefRowMenu
                  label={`Actions for ${worktree.branch}`}
                  items={[
                    {
                      type: "item",
                      label: pinned ? "Unpin worktree" : "Pin worktree",
                      onSelect: () => void togglePin(worktree)
                    },
                    {
                      type: "item",
                      label: "Copy branch name",
                      onSelect: () => void copyText(worktree.branch)
                    },
                    {
                      type: "item",
                      label: "Copy path",
                      onSelect: () => void copyText(worktree.path)
                    }
                  ]}
                />
              }
            />
          </div>
        );
      })}
      {worktrees.length === 0 && (
        <div className="refs-browser__empty">
          {query.trim() === "" ? EMPTY_STATUS[status] : "No matching worktrees."}
        </div>
      )}
      {status === "finished" && worktrees.length > 0 && (
        <div className="refs-worktree-foot">
          <span>
            Clean, and the work landed: merged or closed, upstream gone, or
            already in the default branch.
          </span>
          {onPruneWorktrees !== undefined && (
            <button
              type="button"
              className="refs-action"
              {...hoverTooltip(
                tip,
                "Opens Maintenance › Prune worktrees for this profile. Nothing is ticked until you tick it."
              )}
              onClick={() => {
                tip.hide();
                onPruneWorktrees();
              }}
            >
              Prune worktrees…
            </button>
          )}
        </div>
      )}
      {tip.tooltipNode}
    </div>
  );
}
