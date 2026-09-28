import { describe, expect, it, vi } from "vitest";
import {
  createMissingRepoRescan,
  MISSING_REPO_RESCAN_COOLDOWN_MS
} from "./missing-repo-rescan";

describe("missing repository rescan", () => {
  it("rescans the repository's profile once per cooldown, not every poll", () => {
    let clock = 0;
    const rescan = vi.fn();
    const onMissing = createMissingRepoRescan({
      profileOf: (repoId) => (repoId === "gone" ? "one" : null),
      rescan,
      now: () => clock
    });
    onMissing("gone");
    expect(rescan).toHaveBeenCalledExactlyOnceWith("one");
    // A hand-added repository is never pruned, so the 15s poll keeps
    // finding it missing: that must not become a rescan every 15s.
    clock += 15_000;
    onMissing("gone");
    expect(rescan).toHaveBeenCalledOnce();
    clock += MISSING_REPO_RESCAN_COOLDOWN_MS;
    onMissing("gone");
    expect(rescan).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a repository whose row is already gone", () => {
    const rescan = vi.fn();
    createMissingRepoRescan({ profileOf: () => null, rescan })("pruned");
    expect(rescan).not.toHaveBeenCalled();
  });
});
