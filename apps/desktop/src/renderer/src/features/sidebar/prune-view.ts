import {
  formatBytes,
  normalizeExcludes,
  type PrunableReason,
  type PruneCandidate,
  type ReclaimPlan
} from "@pwrgit/shared";

/**
 * View logic for the worktree pruner, kept out of the dialog so the ordering,
 * the totals and — above all — the wording of the reasons are testable.
 *
 * The reason text is not decoration. It is the only thing on the row that lets
 * a user disagree with the sweep, so "merged PR #12" and "no common ancestor
 * with main" must read as the different claims they are.
 */
export function reasonLabel(reason: PrunableReason): string {
  switch (reason.kind) {
    case "merged_pr":
      return `merged PR #${reason.prNumber}`;
    case "merged_into_default":
      return `merged into ${reason.defaultBranch}`;
    case "diverged":
      return `no common ancestor with ${reason.defaultBranch}`;
  }
}

/** A longer form for the confirm, where there is room to be explicit. */
export function reasonDetail(reason: PrunableReason): string {
  switch (reason.kind) {
    case "merged_pr":
      return `its pull request #${reason.prNumber} is merged`;
    case "merged_into_default":
      return `every commit is already in ${reason.defaultBranch}`;
    case "diverged":
      return `it shares no history with ${reason.defaultBranch}`;
  }
}

/** Reason rank for a tie-break, worst-understood last. */
const REASON_RANK: Record<PrunableReason["kind"], number> = {
  merged_pr: 0,
  merged_into_default: 1,
  diverged: 2
};

/**
 * Biggest first — the pruner exists to recover disk, so the row that recovers
 * the most belongs at the top. Unsized rows (a cancelled sizing pass) sort
 * after every sized one rather than to the top as a zero would.
 */
export function sortCandidates(candidates: PruneCandidate[]): PruneCandidate[] {
  return [...candidates].sort((a, b) => {
    const aSize = a.sizeBytes;
    const bSize = b.sizeBytes;
    if (aSize === null && bSize !== null) return 1;
    if (bSize === null && aSize !== null) return -1;
    if (aSize !== null && bSize !== null && aSize !== bSize) return bSize - aSize;
    if (REASON_RANK[a.reason.kind] !== REASON_RANK[b.reason.kind]) {
      return REASON_RANK[a.reason.kind] - REASON_RANK[b.reason.kind];
    }
    return (
      a.repoName.localeCompare(b.repoName) || a.branch.localeCompare(b.branch)
    );
  });
}

export type SelectionTotals = {
  count: number;
  bytes: number;
  /** Some selected row's size is a floor, so the total is one too. */
  partial: boolean;
  /** Selected rows whose size is unknown; the bytes total omits them. */
  unsized: number;
  repos: number;
};

export function selectionTotals(
  candidates: PruneCandidate[],
  selected: ReadonlySet<string>
): SelectionTotals {
  const repos = new Set<string>();
  let bytes = 0;
  let count = 0;
  let partial = false;
  let unsized = 0;
  for (const candidate of candidates) {
    if (!selected.has(candidate.worktreeId)) continue;
    count += 1;
    repos.add(candidate.repoId);
    if (candidate.sizeBytes === null) unsized += 1;
    else bytes += candidate.sizeBytes;
    if (candidate.sizePartial === true) partial = true;
  }
  return { count, bytes, partial, unsized, repos: repos.size };
}

/** "3.4 GB" / "at least 3.4 GB" / "3.4 GB (2 not measured)". */
export function describeBytes(totals: {
  bytes: number;
  partial: boolean;
  unsized: number;
}): string {
  const base = totals.partial
    ? `at least ${formatBytes(totals.bytes)}`
    : formatBytes(totals.bytes);
  if (totals.unsized === 0) return base;
  return `${base} (${totals.unsized} not measured)`;
}

/**
 * The confirm's body. It names the count, every repo involved, and why each
 * row qualified — the pruner's whole claim, in the one place the user is
 * committing to it.
 */
export function removalConfirmMessage(
  selected: PruneCandidate[],
  totals: SelectionTotals
): string {
  const lines = sortCandidates(selected)
    .slice(0, 8)
    .map(
      (candidate) =>
        `• ${candidate.repoName} · ${candidate.branch} — ${reasonDetail(candidate.reason)}`
    );
  const more =
    selected.length > lines.length ? [`…and ${selected.length - lines.length} more`] : [];
  const scope =
    totals.repos === 1 ? "1 repository" : `${totals.repos} repositories`;
  return [
    `${totals.count} worktree${totals.count === 1 ? "" : "s"} across ${scope}, freeing ${describeBytes(totals)}.`,
    "",
    ...lines,
    ...more,
    "",
    "Their working directories are deleted. Branches and commits are kept."
  ].join("\n");
}

/** One exclude pattern per line, which is how the field is edited. */
export function parseExcludeLines(text: string): string[] {
  return normalizeExcludes(text.split("\n"));
}

export function formatExcludeLines(patterns: readonly string[]): string {
  return patterns.join("\n");
}

export type ReclaimTotals = {
  worktrees: number;
  bytes: number;
  paths: number;
  truncated: boolean;
  /** Some plan's sizing was cut short, so `bytes` is a floor. */
  partial: boolean;
};

export function reclaimTotals(plans: ReclaimPlan[]): ReclaimTotals {
  let bytes = 0;
  let paths = 0;
  let truncated = false;
  let partial = false;
  for (const plan of plans) {
    bytes += plan.totalBytes;
    paths += plan.pathCount;
    if (plan.truncated) truncated = true;
    if (plan.sizesPartial === true) partial = true;
    if (plan.entries.some((entry) => entry.sizePartial === true)) partial = true;
  }
  return { worktrees: plans.length, bytes, paths, truncated, partial };
}

/** "3.4 GB", or "at least 3.4 GB" when any size is a floor. */
export function describeReclaimBytes(totals: ReclaimTotals): string {
  return totals.partial
    ? `at least ${formatBytes(totals.bytes)}`
    : formatBytes(totals.bytes);
}

/**
 * The reclaim confirm. It says what survives as plainly as what does not:
 * "ignored" is routinely read as "worthless", and the files that make this
 * dangerous — a `.env`, a local database — are exactly the ignored ones.
 */
export function reclaimConfirmMessage(
  totals: ReclaimTotals,
  excludes: readonly string[]
): string {
  const spared =
    excludes.length === 0
      ? "Nothing is being spared — the exclude list is empty."
      : `Spared by your exclude list: ${excludes.join(", ")}.`;
  return [
    `${totals.paths} ignored path${totals.paths === 1 ? "" : "s"} across ${totals.worktrees} worktree${
      totals.worktrees === 1 ? "" : "s"
    }, freeing ${describeReclaimBytes(totals)}.`,
    "",
    "Tracked files, branches and commits are untouched, and the worktrees stay usable — they will need a reinstall or rebuild.",
    "",
    "Ignored files have no commit behind them, so this cannot be undone.",
    spared
  ].join("\n");
}
