import { describe, expect, it, vi } from "vitest";
import {
  createMissingRepoRescan,
  MISSING_REPO_RESCAN_COOLDOWN_MS
} from "./missing-repo-rescan";

describe("missing repository rescan", () => {
  it("rescans the repository's profile once per cooldown, not every poll", () => {
    let clock = 0;
    const rescan = vi.fn(() => true);
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

  it("asks again when its first ask found the profile already scanning", () => {
    // That scan may have listed the folder before it was deleted.
    const rescan = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const onMissing = createMissingRepoRescan({
      profileOf: () => "one",
      rescan,
      now: () => 0
    });
    onMissing("gone");
    onMissing("gone");
    onMissing("gone");
    expect(rescan).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a repository whose row is already gone", () => {
    const rescan = vi.fn(() => true);
    createMissingRepoRescan({ profileOf: () => null, rescan })("pruned");
    expect(rescan).not.toHaveBeenCalled();
  });
});
