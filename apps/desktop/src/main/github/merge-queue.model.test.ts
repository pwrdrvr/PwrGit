import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeQueueStatus, type MergeQueueStatus } from "@pwrgit/shared";
import { parseMergeQueue, serializeMergeQueue } from "../forge/pr-row";
import { parsePrNumberResponse } from "./pr-query";

/**
 * Model test: GitHub's merge queue, end to end through PwrGit's reading of it.
 *
 * The model is a small, obviously-correct stand-in for one pull request on
 * GitHub: it knows the PR's true situation (in the queue? merged by whom?
 * dropped, and why?) because it made it happen. After every command it
 * renders what GitHub's GraphQL would answer for that PR — the fields
 * `pr-query.ts` asks for, including the queue timeline event GitHub actually
 * emits (a queue merge ends with `RemovedFromMergeQueueEvent` reason
 * `merged`, as bevyengine/bevy's history shows) — and the real pipeline reads
 * it: the GraphQL parser, the `merge_queue` column round trip, and
 * `mergeQueueStatus`. The two must agree on the queue state every time.
 */

type Checks = "passing" | "failing" | "pending";

type Model = {
  lifecycle: "open" | "merged" | "closed";
  draft: boolean;
  checks: Checks;
  approved: boolean;
  required: boolean;
  /** The entry while queued; `running` is the merge group's checks. */
  entry: { position: number; running: boolean } | null;
  /** Every queue event GitHub would have on the timeline, oldest first. */
  events: { kind: "added" | "removed"; reason?: string }[];
  /** Ground truth, not derived from events. */
  mergedByQueue: boolean;
  /** Dropped from the queue, still out of it: the reason. */
  dropped: string | null;
};

const initial = (): Model => ({
  lifecycle: "open",
  draft: false,
  checks: "pending",
  approved: false,
  required: true,
  entry: null,
  events: [],
  mergedByQueue: false,
  dropped: null
});

type Command = { name: string; run: (m: Model) => void };

const open = (m: Model): boolean => m.lifecycle === "open";

/** What GitHub would accept: an open, ready PR on a queue base, not queued. */
const canEnqueue = (m: Model): boolean =>
  open(m) && m.required && m.entry === null && !m.draft &&
  m.checks === "passing" && m.approved;

const commands: fc.Arbitrary<Command>[] = [
  // What a user does before queueing: un-draft, green CI, an approval. As
  // three separate random steps the queue states were too rare to test.
  fc.constant<Command>({
    name: "readyUp",
    run: (m) => {
      if (!open(m) || m.entry !== null) return;
      Object.assign(m, { draft: false, checks: "passing", approved: true });
    }
  }),
  fc.boolean().map((draft) => ({
    name: `draft(${draft})`,
    run: (m) => { if (open(m) && m.entry === null) m.draft = draft; }
  })),
  fc.constantFrom<Checks>("passing", "failing", "pending").map((checks) => ({
    name: `ci(${checks})`,
    run: (m) => { if (open(m)) m.checks = checks; }
  })),
  fc.boolean().map((approved) => ({
    name: `review(${approved ? "approved" : "required"})`,
    run: (m) => { if (open(m)) m.approved = approved; }
  })),
  fc.boolean().map((required) => ({
    name: `queueRequired(${required})`,
    // GitHub's queue setting is the base branch's; flipping it under a queued
    // PR is not a state this test claims anything about.
    run: (m) => { if (m.entry === null && open(m)) m.required = required; }
  })),
  fc.integer({ min: 1, max: 9 }).map((position) => ({
    name: `enqueue(#${position})`,
    run: (m) => {
      if (!canEnqueue(m)) return;
      m.entry = { position, running: false };
      m.events.push({ kind: "added" });
      m.dropped = null;
    }
  })),
  fc.constant<Command>({
    name: "groupChecksStart",
    run: (m) => { if (m.entry !== null) m.entry.running = true; }
  }),
  fc.constant<Command>({
    name: "groupPassAndMerge",
    run: (m) => {
      if (m.entry === null || !m.entry.running) return;
      m.entry = null;
      m.lifecycle = "merged";
      m.mergedByQueue = true;
      m.events.push({ kind: "removed", reason: "merged" });
    }
  }),
  fc.constantFrom("failed_checks", "merge_conflict", "manually_dequeued").map((reason) => ({
    name: `dropped(${reason})`,
    run: (m: Model) => {
      if (m.entry === null) return;
      m.entry = null;
      m.dropped = reason;
      m.events.push({ kind: "removed", reason });
    }
  })),
  fc.constant<Command>({
    name: "directMerge(bypass)",
    run: (m) => {
      if (!open(m) || m.entry !== null) return;
      m.lifecycle = "merged";
      m.mergedByQueue = false;
    }
  }),
  fc.constant<Command>({
    name: "close",
    run: (m) => {
      if (!open(m)) return;
      m.lifecycle = "closed";
      if (m.entry !== null) {
        m.entry = null;
        m.events.push({ kind: "removed", reason: "closed" });
      }
    }
  })
];

/** The GraphQL node GitHub would return for the model's PR. */
function githubNode(m: Model): Record<string, unknown> {
  const rollup = m.checks === "passing" ? "SUCCESS"
    : m.checks === "failing" ? "FAILURE" : "PENDING";
  const last = m.events.at(-1);
  const blocked = !m.approved || m.checks !== "passing";
  return {
    number: 7,
    title: "t",
    url: "https://github.com/o/r/pull/7",
    state: m.lifecycle.toUpperCase(),
    isDraft: m.draft,
    mergeable: "MERGEABLE",
    isCrossRepository: false,
    commits: {
      totalCount: 1,
      nodes: [{ commit: { statusCheckRollup: { state: rollup, contexts: {
        checkRunCountsByState: [{ state: rollup === "PENDING" ? "IN_PROGRESS" : rollup, count: 1 }],
        statusContextCountsByState: []
      } } } }]
    },
    isMergeQueueEnabled: m.required,
    isInMergeQueue: m.entry !== null,
    reviewDecision: m.approved ? "APPROVED" : "REVIEW_REQUIRED",
    mergeStateStatus: m.lifecycle !== "open" ? "UNKNOWN"
      : m.draft ? "DRAFT" : blocked ? "BLOCKED" : "CLEAN",
    mergeQueueEntry: m.entry === null ? null : {
      state: m.entry.running ? "AWAITING_CHECKS" : "QUEUED",
      position: m.entry.position,
      estimatedTimeToMerge: null,
      enqueuedAt: "2026-11-11T00:00:00Z"
    },
    mergeQueue: m.required ? { configuration: null } : null,
    queueEvents: {
      nodes: last === undefined ? [] : [{
        __typename: last.kind === "added" ? "AddedToMergeQueueEvent" : "RemovedFromMergeQueueEvent",
        createdAt: "2026-11-11T00:00:00Z",
        ...(last.kind === "removed" ? { reason: last.reason } : {})
      }]
    }
  };
}

/** The model's own answer, from ground truth only. */
function expected(m: Model): MergeQueueStatus["kind"] | null {
  if (m.lifecycle === "closed") return null;
  if (m.lifecycle === "merged") return m.mergedByQueue ? "merged_by_queue" : null;
  if (m.entry !== null) return m.entry.running ? "group_checks_running" : "queued";
  if (m.dropped !== null) return "removed";
  if (!m.required) return null;
  return canEnqueue(m) ? "ready_to_queue" : "not_ready";
}

/** PwrGit's answer: parse, store, read back, map. */
function pwrgit(m: Model): MergeQueueStatus | null {
  const parsed = parsePrNumberResponse([7], { repository: { n0: githubNode(m) } }).get(7);
  if (parsed == null) throw new Error("parser dropped the PR");
  const stored = parseMergeQueue(serializeMergeQueue(parsed.mergeQueue));
  return mergeQueueStatus({ ...parsed, ...(stored === undefined ? {} : { mergeQueue: stored }) });
}

describe("merge queue model (GitHub)", () => {
  it("PwrGit reports the queue state the PR is really in, after every step", () => {
    const reached = new Set<string>();
    fc.assert(
      fc.property(fc.array(fc.oneof(...commands.map((arbitrary, index) => ({
        arbitrary,
        // The terminal steps (bypass merge, close) end the story; drawn as
        // often as the rest, a queue merge was rarely reached.
        weight: index >= commands.length - 2 ? 1 : 6
      }))), { minLength: 6, maxLength: 30 }), (steps) => {
        const m = initial();
        for (const step of [{ name: "start", run: () => undefined } as Command, ...steps]) {
          step.run(m);
          const status = pwrgit(m);
          reached.add(String(expected(m)));
          expect(status?.kind ?? null, step.name).toBe(expected(m));
          if (status?.kind === "removed") expect(status.reason).toBe(m.dropped);
          if (status?.kind === "queued" || status?.kind === "group_checks_running") {
            expect(status.position).toBe(m.entry?.position);
          }
        }
      }),
      { numRuns: 1000 }
    );
    // A model that never reaches a state proves nothing about it.
    expect([...reached].sort()).toEqual([
      "group_checks_running", "merged_by_queue", "not_ready", "null", "queued",
      "ready_to_queue", "removed"
    ]);
  });

  it("a queue merge is merged by the queue even though its last event is a removal", () => {
    // Shrunk counterexample, kept by name: the removal GitHub writes when the
    // queue merges a PR has reason `merged`, and it is not a failure.
    const m = initial();
    Object.assign(m, { checks: "passing", approved: true });
    m.entry = { position: 1, running: true };
    m.events.push({ kind: "added" });
    m.entry = null;
    m.lifecycle = "merged";
    m.mergedByQueue = true;
    m.events.push({ kind: "removed", reason: "merged" });
    expect(pwrgit(m)?.kind).toBe("merged_by_queue");
  });
});
