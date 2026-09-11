import type { PrSummary } from "@pwrgit/shared";

/** Shared by the chip and card; lifecycle wins over stale CI and draft bits. */
export function prPresentation(pr: PrSummary) {
  const open = pr.state === "open";
  const conflicting = open && pr.mergeState === "conflicting";
  const draft = open && pr.isDraft;
  const dot = !open ? pr.state : conflicting ? "conflicting" : pr.checkState ?? "unknown";
  const running = open && pr.checkState === "failing" && pr.checksStillRunning === true;
  const parts = [draft ? "draft" : "ready for review"];
  if (conflicting) parts.push("merge conflict");
  parts.push(pr.checkState === "passing" ? "checks passing"
    : pr.checkState === "failing" ? "checks failing"
    : pr.checkState === "pending" ? "checks pending" : "status unknown");
  if (running) parts.push("checks still running");
  return {
    dot, draft, running,
    label: open ? parts.join(" · ") : pr.state === "closed" ? "closed without merge" : "merged"
  };
}
