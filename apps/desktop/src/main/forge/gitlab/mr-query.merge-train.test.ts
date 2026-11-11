import { describe, expect, it } from "vitest";
import { mergeQueueStatus } from "@pwrgit/shared";
import { buildMrBranchQuery, mergeTrainSummary, toSummary, type MrNode } from "./mr-query";
import { refusedTrainFields } from "./mr-client";

const mr = (fields: Partial<MrNode>): MrNode => ({
  iid: "4", title: "t", state: "opened", draft: false, webUrl: "u", ...fields
});

/** Status as the chip reads it, from a node shaped like GitLab's GraphQL. */
const status = (fields: Partial<MrNode>) => mergeQueueStatus(toSummary(mr(fields)))?.kind ?? null;

describe("GitLab merge trains", () => {
  it("asks for the train fields, and drops them on request", () => {
    expect(buildMrBranchQuery("g/sub/p", ["b"]).query).toContain("mergeTrainCar");
    expect(buildMrBranchQuery("g/sub/p", ["b"], null, { mergeTrain: false }).query)
      .not.toContain("mergeTrainCar");
  });

  it("reads a car's status as GitHub's entry states", () => {
    const car = (status: string, pipeline?: string) => ({
      mergeTrainCar: { status, index: 1, ...(pipeline === undefined ? {} : { pipeline: { status: pipeline } }) },
      availableAutoMergeStrategies: []
    });
    expect(status(car("IDLE"))).toBe("queued");
    expect(status(car("STALE"))).toBe("queued");
    expect(status(car("FRESH", "RUNNING"))).toBe("group_checks_running");
    expect(status(car("FRESH", "SUCCESS"))).toBe("queued");
    expect(status(car("MERGING"))).toBe("queued");
    expect(mergeTrainSummary(mr(car("FRESH", "RUNNING"))).mergeQueue?.entry?.position).toBe(2);
  });

  it("a merged car is the train's merge; skipping the train is not", () => {
    expect(status({ state: "merged", mergeTrainCar: { status: "MERGED" }, availableAutoMergeStrategies: [] }))
      .toBe("merged_by_queue");
    expect(status({ state: "merged", mergeTrainCar: { status: "SKIP_MERGED" }, availableAutoMergeStrategies: [] }))
      .toBeNull();
  });

  it("a project that offers the train strategy requires the train", () => {
    const strategies = { availableAutoMergeStrategies: ["merge_train", "add_to_merge_train_when_checks_pass"] };
    expect(status({ ...strategies, mergeTrainCar: null, detailedMergeStatus: "MERGEABLE" })).toBe("ready_to_queue");
    expect(status({ ...strategies, mergeTrainCar: null, detailedMergeStatus: "NOT_APPROVED" })).toBe("not_ready");
    expect(status({ availableAutoMergeStrategies: ["merge_when_checks_pass"], mergeTrainCar: null })).toBeNull();
  });

  it("REST nodes and instances without the fields say nothing about a train", () => {
    expect(toSummary(mr({})).mergeQueue).toBeUndefined();
  });

  it("recognises a schema refusal of the train fields only", () => {
    const refusal = (field: string) => ({
      errors: [{ message: `Field '${field}' doesn't exist on type 'MergeRequest'` }]
    });
    expect(refusedTrainFields(refusal("mergeTrainCar"))).toBe(true);
    expect(refusedTrainFields(refusal("somethingElse"))).toBe(false);
    expect(refusedTrainFields({ errors: [{ message: "Internal server error" }] })).toBe(false);
  });
});
