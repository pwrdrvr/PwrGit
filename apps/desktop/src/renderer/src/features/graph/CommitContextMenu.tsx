import type { LaneBranchInfo, RebaseOperation } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import { changeRequestMenuItems } from "../shell/change-request-menu-items";
import type { GraphRowVM } from "./GraphRow";
import {
  branchRefsAtCommit,
  type CommitSwitchTarget,
  commitUrlForPullRequest,
  pullRequestsAtCommit,
  switchTargetsAtCommit
} from "./commit-context-menu";
import type { HistoryRange } from "./history-range";

/** Context actions for a lineage commit. PR actions are shown only when a
 * branch that tips this exact commit has cached PR metadata. */
export function CommitContextMenu({
  x,
  y,
  vm,
  branchInfo,
  viewingBranch,
  worktreeId,
  onViewChanges,
  onBranchFrom,
  onTagFrom,
  onSwitchBranch,
  onRevealWorktree,
  historyRange,
  onEditHistory,
  onClose
}: {
  x: number;
  y: number;
  vm: GraphRowVM;
  branchInfo: Record<string, LaneBranchInfo>;
  viewingBranch: string;
  /** The worktree these actions move — its own checkout, not the repo's. */
  worktreeId: string;
  onViewChanges: () => void;
  onBranchFrom: () => void;
  /** Create a tag at this commit. Never moves a worktree. */
  onTagFrom: () => void;
  /** Check a branch tipped here out in the viewed worktree. */
  onSwitchBranch: (target: CommitSwitchTarget) => void;
  /** Jump to the worktree already holding a branch tipped here. */
  onRevealWorktree: (worktreeId: string) => void;
  /** The run from HEAD down to this commit, for "Edit history from here". */
  historyRange: HistoryRange | null;
  /** Select the run and open the rebase tool on one operation. */
  onEditHistory: (hashes: string[], op: RebaseOperation) => void;
  onClose: () => void;
}) {
  const { commit } = vm;
  const switchTargets = switchTargetsAtCommit(
    vm.refs,
    vm.remoteRefs,
    branchInfo,
    viewingBranch,
    worktreeId
  );
  const branchRefs = branchRefsAtCommit(vm.refs, vm.remoteRefs);
  const items: MenuItem[] = [
    { type: "item", label: "View changes", onSelect: onViewChanges },
    // Moving this worktree onto a branch drawn here is the action the graph
    // most obviously implies, so it sits with the other commit verbs rather
    // than only in the header switcher.
    ...switchTargets.map((target): MenuItem => {
      const holder = target.checkedOutIn;
      // A branch git already has checked out elsewhere cannot be switched to;
      // offering that worktree beats an action that can only fail.
      if (holder !== undefined) {
        return {
          type: "item",
          label: `Open the ${target.branch} worktree`,
          onSelect: () => onRevealWorktree(holder)
        };
      }
      return {
        type: "item",
        label: target.isRemoteOnly
          ? `Switch to ${target.branch} from ${target.ref}`
          : `Switch to ${target.branch}`,
        onSelect: () => onSwitchBranch(target)
      };
    }),
    {
      type: "item",
      label: "Branch from this commit…",
      onSelect: onBranchFrom
    },
    {
      type: "item",
      label: "Tag this commit…",
      onSelect: onTagFrom
    },
    ...historyItems(historyRange, onEditHistory),
    { type: "sep" },
    {
      type: "item",
      label: "Copy short SHA",
      onSelect: () => void copyText(commit.shortHash)
    },
    {
      type: "item",
      label: "Copy full SHA",
      onSelect: () => void copyText(commit.hash)
    },
    {
      type: "item",
      label: "Copy commit message",
      onSelect: () => void copyText(commit.subject)
    },
    {
      type: "item",
      label: "Copy author email",
      disabled: commit.authorEmail === "",
      onSelect: () => void copyText(commit.authorEmail)
    },
    // The chips are capped and truncated on the row, so the branches drawn
    // here are copyable in full from the menu — including any the +N pill hid.
    ...branchRefs.map((ref): MenuItem => ({
      type: "item",
      label:
        branchRefs.length === 1
          ? "Copy branch name"
          : `Copy branch name (${ref})`,
      onSelect: () => void copyText(ref)
    })),
    {
      type: "item",
      label: "Copy viewing branch",
      onSelect: () => void copyText(viewingBranch)
    },
    {
      type: "item",
      label: "Copy base branch",
      onSelect: () => void copyText(vm.defaultBranch)
    }
  ];
  const pullRequests = pullRequestsAtCommit(
    vm.refs,
    vm.remoteRefs,
    branchInfo
  );
  if (pullRequests.length > 0) {
    items.push({ type: "sep" });
    const commitLinks = new Set<string>();
    for (const pr of pullRequests) {
      items.push(...changeRequestMenuItems(pr));
      const commitLink = commitUrlForPullRequest(pr, commit.hash);
      if (commitLink === null || commitLinks.has(commitLink)) continue;
      commitLinks.add(commitLink);
      items.push({
        type: "item",
        label: "Copy commit link",
        onSelect: () => void copyText(commitLink)
      });
    }
  }

  return (
    <ContextMenu
      x={x}
      y={y}
      label="Commit actions"
      items={items}
      onClose={onClose}
    />
  );
}

/** "Edit history from here": the run always ends at HEAD, so the commit
 *  right-clicked is the one choice to make, and each entry names the count
 *  so the range is visible before choosing (design: Rebase Selection Column,
 *  2a). */
function historyItems(
  range: HistoryRange | null,
  onEditHistory: (hashes: string[], op: RebaseOperation) => void
): MenuItem[] {
  if (range === null) return [];
  const heading: MenuItem[] = [
    { type: "sep" },
    {
      type: "heading",
      label: "Edit history from here",
      ...(range.kind === "range" && range.pushed > 0
        ? { hint: pushedWarning(range.pushed, range.hashes.length) }
        : {})
    }
  ];
  if (range.kind === "blocked") {
    return [
      ...heading,
      {
        type: "item",
        label: `Squash or reorder ${range.count} commits`,
        disabled: true,
        hint:
          range.reason === "merge"
            ? "A merge sits between here and HEAD."
            : "This reaches the repository's first commit.",
        onSelect: () => undefined
      }
    ];
  }
  const { hashes } = range;
  const n = hashes.length;
  return [
    ...heading,
    {
      type: "item",
      label: `Squash ${n} commits into one…`,
      onSelect: () => onEditHistory(hashes, "squash")
    },
    {
      type: "item",
      label: `Reorder ${n} commits…`,
      onSelect: () => onEditHistory(hashes, "reorder")
    }
  ];
}

/** Said once, under the heading, for every entry in the group: rewriting a
 *  commit a remote already has is local until a force push, which is the
 *  part that changes history for everyone else. */
export function pushedWarning(pushed: number, total: number): string {
  const which =
    pushed === total
      ? total === 2
        ? "Both are already pushed."
        : `All ${total} are already pushed.`
      : `${pushed} of these ${total} ${pushed === 1 ? "is" : "are"} already pushed.`;
  return `${which} Publishing the rewrite needs a force push.`;
}
