import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { changedEvents } from "./live-events.js";
import type { LiveStatusSnapshot } from "./types.js";

function snapshot(overrides: Partial<LiveStatusSnapshot> = {}): LiveStatusSnapshot {
  return {
    observedAt: "2026-08-23T12:00:00.000Z",
    repositoryPath: resolve("/tmp/pwrgit-live-test"),
    identity: { provider: "github", host: "github.com", path: "acme/widget" },
    local: {
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      conflictedFiles: 0,
      changedFiles: 0,
      clean: true,
      operation: null
    },
    changeRequest: {
      provider: "github",
      host: "github.com",
      repository: "acme/widget",
      number: 1,
      url: "https://github.com/acme/widget/pull/1",
      state: "open",
      draft: false,
      sourceBranch: "main",
      targetBranch: "main"
    },
    ci: {
      state: "running",
      total: 1,
      succeeded: 0,
      failed: 0,
      running: 1,
      pending: 0,
      skipped: 0
    },
    mergeConflict: false,
    reviews: {
      decision: "none",
      blocking: false,
      blockingReason: null,
      latest: []
    },
    providerAvailable: true,
    ...overrides
  };
}

describe("live event contract", () => {
  it("emits distinct normalized events for requested status changes", () => {
    const previous = snapshot();
    const current = snapshot({
      ci: { ...previous.ci, state: "terminal_failure", failed: 1, running: 0 },
      mergeConflict: true,
      reviews: {
        decision: "changes_requested",
        blocking: true,
        blockingReason: "changes_requested",
        latest: [
          {
            id: "review-1",
            actor: "reviewer",
            state: "changes_requested",
            submittedAt: "2026-08-23T12:01:00Z"
          }
        ]
      }
    });
    expect(changedEvents(previous, current).map((event) => event.kind)).toEqual([
      "ci.status",
      "merge.conflict",
      "review.submitted",
      "review.blocking"
    ]);
  });

  it("notifies when a review blocker clears or provider availability changes", () => {
    const previous = snapshot({
      reviews: {
        decision: "changes_requested",
        blocking: true,
        blockingReason: "changes_requested",
        latest: []
      }
    });
    const current = snapshot({ providerAvailable: false });

    expect(changedEvents(previous, current).map((event) => event.kind)).toEqual([
      "repository.status",
      "review.blocking"
    ]);
  });

});
