import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MERGE_QUEUE_ENTRY_STATES,
  type PrMergeQueue,
  type PrSummary
} from "@pwrgit/shared";
import { prPresentation } from "./pr-status";

/**
 * The chip and card must never tell a queue story wrong.
 *
 * Promises (from the merge-queue task, not from today's output):
 * - A PR in the merge queue is neither merged nor plain green: its dot is a
 *   queue dot and its label says it is queued, whatever its own CI says.
 * - A PR the queue merged says so.
 * - A PR the queue dropped says it was removed, and why.
 *
 * Against the code before the merge-queue change, the first shrank to an
 * open, passing PR with a `queued` entry, drawn `passing` / "checks passing".
 */

const checkState = fc.constantFrom<NonNullable<PrSummary["checkState"]>>(
  "passing", "failing", "pending", "unknown"
);

const basePr = fc.record({
  isDraft: fc.boolean(),
  checkState,
  checksStillRunning: fc.boolean(),
  mergeState: fc.constantFrom<NonNullable<PrSummary["mergeState"]>>(
    "mergeable", "conflicting", "unknown"
  )
});

const entry = fc.record({
  state: fc.constantFrom(...MERGE_QUEUE_ENTRY_STATES),
  position: fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined })
}).map(({ state, position }) => ({ state, ...(position === undefined ? {} : { position }) }));

function summary(
  base: { isDraft: boolean; checkState: PrSummary["checkState"]; checksStillRunning: boolean; mergeState: PrSummary["mergeState"] },
  state: PrSummary["state"],
  mergeQueue: PrMergeQueue
): PrSummary {
  return {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "t",
    state,
    isDraft: base.isDraft,
    ...(base.checkState === undefined ? {} : { checkState: base.checkState }),
    checksStillRunning: base.checksStillRunning,
    ...(base.mergeState === undefined ? {} : { mergeState: base.mergeState }),
    mergeQueue
  };
}

const NON_QUEUE_DOTS = ["passing", "failing", "pending", "unknown", "conflicting", "merged"];

describe("prPresentation and the merge queue", () => {
  it("never draws a queued PR as merged or plain green", () => {
    fc.assert(fc.property(basePr, entry, fc.boolean(), (base, queued, required) => {
      const view = prPresentation(summary(base, "open", { required, entry: queued }));
      expect(NON_QUEUE_DOTS).not.toContain(view.dot);
      expect(view.label).toMatch(/queue/);
      expect(view.label).not.toMatch(/checks passing|^merged/);
    }));
  });

  it("says a queue merge was the queue's", () => {
    fc.assert(fc.property(
      basePr,
      fc.constantFrom<PrMergeQueue["lastEvent"]>(
        { kind: "added" },
        { kind: "removed", reason: "merged" }
      ),
      (base, lastEvent) => {
        const view = prPresentation(summary(base, "merged", { required: true, lastEvent: lastEvent! }));
        expect(view.label).toBe("merged by queue");
        expect(view.dot).toBe("merged");
      }
    ));
  });

  it("says a dropped PR was removed, with the reason", () => {
    fc.assert(fc.property(
      basePr,
      fc.constantFrom("failed_checks", "merge_conflict", "some_new_reason"),
      (base, reason) => {
        const view = prPresentation(summary(base, "open", {
          required: true,
          lastEvent: { kind: "removed", reason }
        }));
        expect(view.label).toMatch(/^removed from queue · \S/);
        expect(view.dot).toBe("queue-removed");
      }
    ));
  });

  it("a merge that bypassed the queue is a plain merge", () => {
    fc.assert(fc.property(basePr, (base) => {
      const view = prPresentation(summary(base, "merged", {
        required: true,
        lastEvent: { kind: "removed", reason: "failed_checks" }
      }));
      expect(view.label).toBe("merged");
    }));
  });
});
