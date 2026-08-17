import type { LaneBranchInfo } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";
import type { GraphRowVM } from "./GraphRow";
import {
  commitUrlForPullRequest,
  pullRequestsAtCommit
} from "./commit-context-menu";

/** Context actions for a lineage commit. PR actions are shown only when a
 * branch that tips this exact commit has cached PR metadata. */
export function CommitContextMenu({
  x,
  y,
  vm,
  branchInfo,
  viewingBranch,
  onViewChanges,
  onBranchFrom,
  onClose
}: {
  x: number;
  y: number;
  vm: GraphRowVM;
  branchInfo: Record<string, LaneBranchInfo>;
  viewingBranch: string;
  onViewChanges: () => void;
  onBranchFrom: () => void;
  onClose: () => void;
}) {
  const { commit } = vm;
  const items: MenuItem[] = [
    { type: "item", label: "View changes", onSelect: onViewChanges },
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
