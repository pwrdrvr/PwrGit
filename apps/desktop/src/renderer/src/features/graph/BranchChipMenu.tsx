import type { LaneBranchInfo } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import {
  type CommitSwitchTarget,
  localBranchForRef,
  switchTargetForRef
} from "./commit-context-menu";

/** A branch-tip chip the user clicked, identified as the row drew it. */
export type BranchChipTarget = {
  /** The ref exactly as the chip reads: "feature/x" or "origin/feature/x". */
  ref: string;
  isRemote: boolean;
  x: number;
  y: number;
};

/**
 * Actions for one branch-tip chip. The chip names a branch, so these act on
 * the branch — check it out here, jump to the worktree already holding it,
 * copy its name or that worktree's path — rather than on the commit under it,
 * which keeps its own menu on the rest of the row.
 */
export function BranchChipMenu({
  target,
  branchInfo,
  viewingBranch,
  worktreeId,
  onSwitchBranch,
  onRevealWorktree,
  onClose
}: {
  target: BranchChipTarget;
  branchInfo: Record<string, LaneBranchInfo>;
  /** Branch checked out in the worktree being viewed. */
  viewingBranch: string;
  /** The worktree a switch would move — its own checkout, not the repo's. */
  worktreeId: string;
  onSwitchBranch: (target: CommitSwitchTarget) => void;
  onRevealWorktree: (worktreeId: string) => void;
  onClose: () => void;
}) {
  const branch = localBranchForRef(target.ref, target.isRemote);
  // Adornments are keyed by local branch name, so a remote chip reads the
  // entry for the branch it tracks.
  const info = branchInfo[branch];
  const switchTarget = switchTargetForRef(
    target.ref,
    target.isRemote,
    branchInfo,
    viewingBranch,
    worktreeId
  );
  const holder = switchTarget?.checkedOutIn;

  const items: MenuItem[] = [];
  if (holder !== undefined) {
    items.push({
      type: "item",
      label: "Open its worktree",
      onSelect: () => onRevealWorktree(holder)
    });
  } else if (switchTarget !== null) {
    items.push({
      type: "item",
      label: target.isRemote
        ? `Switch to ${branch} from ${target.ref}`
        : `Switch to ${branch}`,
      onSelect: () => onSwitchBranch(switchTarget)
    });
  }
  if (items.length > 0) items.push({ type: "sep" });

  items.push({
    type: "item",
    label: "Copy branch name",
    onSelect: () => void copyText(target.ref)
  });
  const worktreePath = info?.worktreePath;
  if (worktreePath !== undefined) {
    items.push({
      type: "item",
      label: "Copy worktree path",
      onSelect: () => void copyText(worktreePath)
    });
  }

  const pr = info?.pr;
  if (pr !== undefined && pr.url !== "") {
    items.push(
      { type: "sep" },
      {
        type: "item",
        label: `Open PR #${pr.number}`,
        onSelect: () => void dispatch("shell:openExternal", { url: pr.url })
      },
      {
        type: "item",
        label: `Copy PR #${pr.number} link`,
        onSelect: () => void copyText(pr.url)
      }
    );
  }

  return (
    <ContextMenu
      x={target.x}
      y={target.y}
      label={`${target.ref} actions`}
      items={items}
      onClose={onClose}
    />
  );
}
