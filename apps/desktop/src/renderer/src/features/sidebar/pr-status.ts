import {
  mergeQueueLabel,
  mergeQueueStatus,
  type MergeQueueStatus,
  type PrSummary
} from "@pwrgit/shared";

/**
 * The dot a queue state draws. A PR in the queue is neither merged (purple)
 * nor plain green: it waits, and its merge group's checks decide, so it draws
 * as a ring. `ready_to_queue` and `not_ready` keep the CI dot; the label says
 * what the queue needs.
 */
function queueDot(status: MergeQueueStatus): string | undefined {
  switch (status.kind) {
    case "queued":
      return status.failing ? "queue-failing" : "queued";
    case "group_checks_running":
      return "queued";
    case "removed":
      return "queue-removed";
    case "merged_by_queue":
      return "merged";
    case "ready_to_queue":
      return "queue-ready";
    case "not_ready":
      return undefined;
  }
}

/** Shared by the chip and card; lifecycle wins over stale CI and draft bits. */
export function prPresentation(pr: PrSummary) {
  const open = pr.state === "open";
  const conflicting = open && pr.mergeState === "conflicting";
  const draft = open && pr.isDraft;
  const queue = mergeQueueStatus(pr);
  const ciDot = !open ? pr.state : conflicting ? "conflicting" : pr.checkState ?? "unknown";
  const dot = (queue === null ? undefined : queueDot(queue)) ?? ciDot;
  // In the queue, the PR's own CI no longer decides; the merge group's does.
  const inQueue = queue?.kind === "queued" || queue?.kind === "group_checks_running";
  const running = inQueue
    ? queue.kind === "group_checks_running" || (queue.kind === "queued" && queue.merging)
    : open && pr.checkState === "failing" && pr.checksStillRunning === true;
  const parts = [draft ? "draft" : "ready for review"];
  if (inQueue || queue?.kind === "removed") {
    parts.splice(0, parts.length, mergeQueueLabel(queue));
  } else {
    if (conflicting) parts.push("merge conflict");
    parts.push(pr.checkState === "passing" ? "checks passing"
      : pr.checkState === "failing" ? "checks failing"
      : pr.checkState === "pending" ? "checks pending" : "status unknown");
    if (running) parts.push("checks still running");
    if (queue !== null) parts.push(mergeQueueLabel(queue));
  }
  return {
    dot, draft, running, queue,
    label: open ? parts.join(" · ")
      : pr.state === "closed" ? "closed without merge"
        : queue?.kind === "merged_by_queue" ? "merged by queue" : "merged"
  };
}
