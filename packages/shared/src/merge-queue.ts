import type { PrSummary } from "./types";

/**
 * Merge queues: GitHub's merge queue and GitLab's merge trains.
 *
 * A repository whose base branch requires a queue does not merge a green,
 * approved change request. It waits in the queue; the forge builds a temporary
 * merge group (GitHub's `gh-readonly-queue/<base>/…` branches, GitLab's train
 * refs), runs checks on it, and merges or drops the entry. So "open, checks
 * passing" means three different things depending on the queue, and the
 * lifecycle alone cannot say which.
 *
 * `PrMergeQueue` is the forge's raw answer, normalised across forges. The one
 * reading of it is `mergeQueueStatus`, below; the chip, the card and the
 * enqueue action all go through it.
 */

/** GitHub's `MergeQueueEntryState`, lower-cased. GitLab cars map onto it. */
export const MERGE_QUEUE_ENTRY_STATES = [
  "queued",
  "awaiting_checks",
  "mergeable",
  "unmergeable",
  "locked"
] as const;
export type MergeQueueEntryState = (typeof MERGE_QUEUE_ENTRY_STATES)[number];

export type PrMergeQueue = {
  /**
   * The base branch requires the queue: GitHub's `isMergeQueueEnabled`, or a
   * GitLab project whose MRs offer the merge-train strategy. False is an
   * answer ("merges directly"); a summary without `mergeQueue` is "not known".
   */
  required: boolean;
  /** Present only while the change request is in the queue. */
  entry?: {
    state: MergeQueueEntryState;
    /** 1-based place in the queue, when the forge reports it. */
    position?: number;
    /** Seconds until the forge expects to merge it. */
    etaSeconds?: number;
    /** Epoch milliseconds. */
    enqueuedAt?: number;
  };
  /**
   * The newest queue event on the change request. A queue merge also ends
   * with a removal, whose reason is `merged`, so a removal alone is not a
   * failure.
   */
  lastEvent?: {
    kind: "added" | "removed";
    /** Epoch milliseconds. */
    at?: number;
    /** The forge's removal reason, as sent (`failed_checks`, `merged`, …). */
    reason?: string;
  };
  /**
   * The forge would refuse to enqueue it yet: required review or required
   * checks outstanding. Absent means "not known".
   */
  blocked?: boolean;
  /** The merge method the queue imposes, when the forge says. */
  method?: "merge" | "squash" | "rebase";
};

/**
 * What a change request's queue situation is, in the vocabulary PwrGit and
 * PwrAgent share. Null when no queue applies, or nothing is known about one.
 */
export type MergeQueueStatus =
  /** Required, open, nothing outstanding: the next step is to enqueue it. */
  | { kind: "ready_to_queue"; method?: PrMergeQueue["method"] }
  /** Required, open, but review or required checks are outstanding. */
  | { kind: "not_ready" }
  /** In the queue, waiting its turn (or being merged now, `merging`). */
  | {
      kind: "queued";
      position?: number;
      etaSeconds?: number;
      merging: boolean;
      /** The merge group failed; the forge is about to drop the entry. */
      failing: boolean;
    }
  /** In the queue, and its merge group's checks are running. */
  | { kind: "group_checks_running"; position?: number; etaSeconds?: number }
  /** Dropped from the queue and still open. */
  | { kind: "removed"; reason?: string; at?: number }
  /** Merged, and the queue did it. */
  | { kind: "merged_by_queue"; at?: number };

export type MergeQueueStatusKind = MergeQueueStatus["kind"];

/** The removal reason a queue merge leaves behind. Not a failure. */
const MERGED_REASON = "merged";

/**
 * The one reading of a change request's queue state.
 *
 * Rules, in order:
 * - A closed change request has no queue state.
 * - A merged one was merged by the queue only when the queue's last word was
 *   adding it, or removing it *because* it merged. Anything else is a direct
 *   (or bypassing) merge and reads as plain merged.
 * - An open one in the queue is queued or running its group's checks,
 *   whatever its own CI says: the PR's checks are not what decides now.
 * - An open one out of the queue whose last queue event was a removal for any
 *   reason but `merged` was removed (re-adding it emits `added`, which clears
 *   this).
 * - Otherwise, only a required queue says anything: ready, or not yet.
 */
export function mergeQueueStatus(
  pr: Pick<PrSummary, "state" | "isDraft" | "checkState" | "mergeState" | "mergeQueue">
): MergeQueueStatus | null {
  const queue = pr.mergeQueue;
  if (queue === undefined || pr.state === "closed") return null;
  const last = queue.lastEvent;
  if (pr.state === "merged") {
    const byQueue = queue.entry !== undefined || last?.kind === "added" ||
      (last?.kind === "removed" && last.reason === MERGED_REASON);
    return byQueue ? { kind: "merged_by_queue", ...optional("at", last?.at) } : null;
  }
  const entry = queue.entry;
  if (entry !== undefined) {
    const place = {
      ...optional("position", entry.position),
      ...optional("etaSeconds", entry.etaSeconds)
    };
    if (entry.state === "awaiting_checks") {
      return { kind: "group_checks_running", ...place };
    }
    return {
      kind: "queued",
      ...place,
      merging: entry.state === "locked",
      failing: entry.state === "unmergeable"
    };
  }
  if (last?.kind === "removed" && last.reason !== MERGED_REASON) {
    return {
      kind: "removed",
      ...optional("reason", last.reason),
      ...optional("at", last.at)
    };
  }
  if (!queue.required) return null;
  const ready = !pr.isDraft && queue.blocked !== true &&
    pr.mergeState !== "conflicting" && pr.checkState !== "failing" &&
    pr.checkState !== "pending";
  return ready
    ? { kind: "ready_to_queue", ...optional("method", queue.method) }
    : { kind: "not_ready" };
}

/** Known removal reasons, in the user's words. Unknown ones are humanised. */
const REMOVAL_REASONS: Record<string, string> = {
  failed_checks: "merge group checks failed",
  merge_conflict: "conflicts with the queue",
  manually_dequeued: "removed by hand",
  dequeued: "removed by hand",
  timeout: "merge group checks timed out",
  invalid_merge_commit: "merge group could not be built",
  branch_protections: "branch rules were not met",
  queue_cleared: "the queue was cleared"
};

export function mergeQueueRemovalReason(reason: string | undefined): string | undefined {
  if (reason === undefined || reason.trim() === "") return undefined;
  const key = reason.trim().toLowerCase();
  return REMOVAL_REASONS[key] ?? key.replace(/[_-]+/g, " ");
}

/** "#2", "#2 · ~4 min": where an entry stands. */
function place(status: { position?: number; etaSeconds?: number }): string {
  const parts: string[] = [];
  if (status.position !== undefined) parts.push(`#${status.position}`);
  if (status.etaSeconds !== undefined && status.etaSeconds > 0) {
    parts.push(`~${Math.max(1, Math.round(status.etaSeconds / 60))} min`);
  }
  return parts.join(" · ");
}

/** One line for the chip's label and the card's status row. */
export function mergeQueueLabel(status: MergeQueueStatus): string {
  switch (status.kind) {
    case "ready_to_queue":
      return "ready to queue";
    case "not_ready":
      return "merge queue required";
    case "queued": {
      const where = place(status);
      const head = status.merging ? "merging from queue"
        : status.failing ? "queued · merge group failed" : "queued";
      return where === "" ? head : `${head} ${where}`;
    }
    case "group_checks_running": {
      const where = place(status);
      return where === "" ? "queued · merge group checks running"
        : `queued ${where} · merge group checks running`;
    }
    case "removed": {
      const why = mergeQueueRemovalReason(status.reason);
      return why === undefined ? "removed from queue" : `removed from queue · ${why}`;
    }
    case "merged_by_queue":
      return "merged by queue";
  }
}

/**
 * A remote-tracking ref of a GitHub merge group (`gh-readonly-queue/<base>/…`).
 * GitHub creates and deletes them; they are never anyone's branch, so branch
 * lists, the lineage graph and search leave them out.
 *
 * Takes a full ref (`refs/remotes/origin/gh-readonly-queue/main/pr-1-…`) or a
 * short one (`origin/gh-readonly-queue/…`). Local branches are never matched:
 * one the user made is theirs.
 */
export function isMergeQueueRemoteRef(ref: string): boolean {
  const short = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
  if (ref.startsWith("refs/") && !ref.startsWith("refs/remotes/")) return false;
  return MERGE_GROUP_BRANCH.test(short);
}

/** `<remote…>/gh-readonly-queue/<base>/<rest>`. */
const MERGE_GROUP_BRANCH = /^[^/]+(?:\/[^/]+)*?\/gh-readonly-queue\/.+\/.+$/;

/** A branch name (no remote) that GitHub's merge queue made. */
export function isMergeQueueBranchName(name: string): boolean {
  return /^gh-readonly-queue\/.+\/.+$/.test(name);
}

function optional<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };
}
