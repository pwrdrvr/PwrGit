import { describe, expect, it } from "vitest";
import { landedChangeRequest, worktreeLandedChangeRequest } from "./landed";
import type { PrSummary } from "./types";

const HEAD = "374964e333b39e7a8e0e7709ddf95be7c7af50b7";
const OTHER = "b298d66000000000000000000000000000000000";

const merged: PrSummary = {
  number: 116,
  url: "https://example.test/pull/116",
  title: "Pinned runner readiness",
  state: "merged",
  isDraft: false,
  headOid: HEAD
};

describe("landedChangeRequest", () => {
  it("is the merged change request whose head is the tip of a no-upstream branch", () => {
    expect(landedChangeRequest(merged, HEAD, false)).toBe(merged);
  });

  it("is null once the tip moved on after the merge", () => {
    expect(landedChangeRequest(merged, OTHER, false)).toBeNull();
  });

  it("is null with an upstream: its counts are against that branch, not every remote", () => {
    expect(landedChangeRequest(merged, HEAD, true)).toBeNull();
  });

  it("is null for an open or closed change request", () => {
    expect(landedChangeRequest({ ...merged, state: "open" }, HEAD, false)).toBeNull();
    expect(landedChangeRequest({ ...merged, state: "closed" }, HEAD, false)).toBeNull();
  });

  it("is null without both ends of the comparison", () => {
    const noHead: PrSummary = { ...merged };
    delete noHead.headOid;
    expect(landedChangeRequest(noHead, HEAD, false)).toBeNull();
    expect(landedChangeRequest(merged, undefined, false)).toBeNull();
    expect(landedChangeRequest(merged, "", false)).toBeNull();
    expect(landedChangeRequest(undefined, HEAD, false)).toBeNull();
    expect(landedChangeRequest(null, HEAD, false)).toBeNull();
  });
});

describe("worktreeLandedChangeRequest", () => {
  it("reads no upstream from the row's unpublished tracking", () => {
    expect(
      worktreeLandedChangeRequest({ pr: merged, head: HEAD, tracking: "unpublished" })
    ).toBe(merged);
  });

  it("is null for any other tracking, including one not computed yet", () => {
    expect(
      worktreeLandedChangeRequest({ pr: merged, head: HEAD, tracking: "upstream_missing" })
    ).toBeNull();
    expect(worktreeLandedChangeRequest({ pr: merged, head: HEAD })).toBeNull();
  });
});
