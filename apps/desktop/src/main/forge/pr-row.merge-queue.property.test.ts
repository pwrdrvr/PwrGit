import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MERGE_QUEUE_ENTRY_STATES, type PrMergeQueue } from "@pwrgit/shared";
import { parseMergeQueue, serializeMergeQueue } from "./pr-row";

const time = fc.integer({ min: 0, max: 4_102_444_800_000 });
const queue: fc.Arbitrary<PrMergeQueue> = fc.record({
  required: fc.boolean(),
  entry: fc.record({
    state: fc.constantFrom(...MERGE_QUEUE_ENTRY_STATES),
    position: fc.integer({ min: 1, max: 500 }),
    etaSeconds: fc.integer({ min: 0, max: 86_400 }),
    enqueuedAt: time
  }, { requiredKeys: ["state"] }),
  lastEvent: fc.record({
    kind: fc.constantFrom("added" as const, "removed" as const),
    at: time,
    reason: fc.stringMatching(/^[a-z_]{1,20}$/)
  }, { requiredKeys: ["kind"] }),
  blocked: fc.boolean(),
  method: fc.constantFrom("merge" as const, "squash" as const, "rebase" as const)
}, { requiredKeys: ["required"] });

describe("merge_queue column", () => {
  it("round-trips every queue, and an unchanged queue writes the same string", () => {
    fc.assert(fc.property(queue, (value) => {
      const stored = serializeMergeQueue(value);
      expect(parseMergeQueue(stored)).toEqual(value);
      // The diff writers compare strings: equal queues must serialise equally.
      expect(serializeMergeQueue(parseMergeQueue(stored))).toBe(stored);
    }));
  });

  it("reads an unreadable row as not known, never as no queue", () => {
    for (const bad of [null, "", "{", "[]", "{\"required\":\"yes\"}", 42]) {
      expect(parseMergeQueue(bad)).toBeUndefined();
    }
  });
});
