import { isMacPlatform } from "../../lib/platform";
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
 * Why the byte figure is the size of what is being deleted, and never a
 * promise about free space.
 *
 * Both are measured the same way — summed apparent size of the files — and
 * that quantity is well defined. What is not available is "bytes this will
 * return to the volume", and no per-file API offers it. A package store shares
 * one file's contents between every checkout that needs it: pnpm hard-links on
 * Linux, and on APFS it clones, which `stat` cannot distinguish from a real
 * copy at all — same `nlink`, same `st_blocks`, same `du`. So deleting a
 * checkout's `node_modules` can return a fraction of its apparent size, or
 * none of it. macOS adds a second layer: a local Time Machine snapshot pins
 * the blocks of anything deleted until it expires, so even a correct
 * measurement would read zero and be right.
 *
 * The conclusion is a wording one, not an arithmetic one: say what is being
 * deleted, and say plainly that the disk follows later.
 */
export function diskSpaceNote(platform: string): string {
  if (isMacPlatform(platform)) {
    return (
      "The disk may not shrink by this much straight away: APFS shares file" +
      " contents between clones, so the space returns once the last copy of" +
      " each file is gone, and Time Machine's local snapshots hold deleted" +
      " blocks until they expire. Removing what you are not using is still" +
      " what frees the space — it just arrives later."
    );
  }
  return (
    "The disk may not shrink by this much straight away: package stores" +
    " hard-link one file's contents into every checkout that needs it, so the" +
    " space returns once the last copy of each file is gone."
  );
}

/**
 * The confirm's body. It names the count, every repo involved, and why each
 * row qualified — the pruner's whole claim, in the one place the user is
 * committing to it.
 */
export function removalConfirmMessage(
  selected: PruneCandidate[],
  totals: SelectionTotals,
  platform: string
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
    `${totals.count} worktree${totals.count === 1 ? "" : "s"} across ${scope}, holding ${describeBytes(totals)} on disk.`,
    "",
    ...lines,
    ...more,
    "",
    "Their working directories are deleted. Branches and commits are kept.",
    "",
    diskSpaceNote(platform)
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
  excludes: readonly string[],
  platform: string
): string {
  const spared =
    excludes.length === 0
      ? "Nothing is being spared — the exclude list is empty."
      : `Spared by your exclude list: ${excludes.join(", ")}.`;
  return [
    `${totals.paths} ignored path${totals.paths === 1 ? "" : "s"} across ${totals.worktrees} worktree${
      totals.worktrees === 1 ? "" : "s"
    }, totalling ${describeReclaimBytes(totals)}.`,
    "",
    "Tracked files, branches and commits are untouched, and the worktrees stay usable — they will need a reinstall or rebuild.",
    "",
    "Ignored files have no commit behind them, so this cannot be undone.",
    spared,
    "",
    diskSpaceNote(platform)
  ].join("\n");
}
