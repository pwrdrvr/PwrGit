import type { LaneBranchInfo } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import type { GraphRowVM } from "./GraphRow";
import {
  branchRefsAtCommit,
  type CommitSwitchTarget,
  commitUrlForPullRequest,
  pullRequestsAtCommit,
  switchTargetsAtCommit
} from "./commit-context-menu";

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
  onSwitchBranch,
  onRevealWorktree,
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
  /** Check a branch tipped here out in the viewed worktree. */
  onSwitchBranch: (target: CommitSwitchTarget) => void;
  /** Jump to the worktree already holding a branch tipped here. */
  onRevealWorktree: (worktreeId: string) => void;
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
      items.push(
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
