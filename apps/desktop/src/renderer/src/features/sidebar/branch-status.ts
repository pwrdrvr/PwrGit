import type { LocalBranchSummary } from "@pwrgit/shared";

/**
 * The refs browser's status filter over local branches.
 *
 * `ahead` and `behind` are read off the counts, not off `tracking`, because
 * that is what the sidebar header's ↑n / ↓n count — and each of those counts
 * is a button that opens the browser on its filter. A diverged branch is in
 * both, which is honest: it has something to push AND something to pull.
 */
export type BranchStatusFilter =
  | "all"
  | "ahead"
  | "behind"
  | "gone"
  | "unpublished";

export const BRANCH_STATUS_FILTERS: readonly {
  value: BranchStatusFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "ahead", label: "To push" },
  { value: "behind", label: "Behind" },
  { value: "gone", label: "Gone" },
  { value: "unpublished", label: "Local only" }
];

export function branchMatchesStatus(
  branch: LocalBranchSummary,
  filter: BranchStatusFilter
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "ahead":
      return branch.ahead > 0;
    case "behind":
      return branch.behind > 0;
    case "gone":
      return branch.tracking === "upstream_missing";
    case "unpublished":
      return branch.tracking === "unpublished";
  }
}

/** Every filter's count, through the same predicate the filter lists with,
 *  so a chip can never promise a different number than the list it opens. */
export function branchStatusCounts(
  branches: readonly LocalBranchSummary[]
): Record<BranchStatusFilter, number> {
  const counts = {} as Record<BranchStatusFilter, number>;
  for (const { value } of BRANCH_STATUS_FILTERS)
    counts[value] = branches.filter((branch) =>
      branchMatchesStatus(branch, value)
    ).length;
  return counts;
}

/**
 * Gone branches whose cached pull request merged. A lead for the Gone view's
 * banner, not a verdict: the clean-up review is what proves each one (the tip
 * has to BE the PR's head, or already be in HEAD), and it says so row by row.
 */
export function goneWithMergedPr(
  branches: readonly LocalBranchSummary[]
): number {
  return branches.filter(
    (branch) =>
      branch.tracking === "upstream_missing" && branch.pr?.state === "merged"
  ).length;
}
