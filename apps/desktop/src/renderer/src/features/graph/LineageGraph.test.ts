import { describe, expect, it } from "vitest";
import { reusableCommitAuthorIdentity } from "./LineageGraph";

describe("reusableCommitAuthorIdentity", () => {
  it("keeps a previously proven identity ready for the next hover", () => {
    expect(
      reusableCommitAuthorIdentity({
        identity: { login: "harold" },
        cacheState: "fresh",
        refreshState: "idle"
      })
    ).toEqual({ login: "harold" });
  });

  it("does not make transient misses sticky in the renderer", () => {
    expect(
      reusableCommitAuthorIdentity({
        cacheState: "miss",
        refreshState: "in-flight"
      })
    ).toBeUndefined();
    expect(
      reusableCommitAuthorIdentity({
        cacheState: "miss",
        refreshState: "backing-off"
      })
    ).toBeUndefined();
  });

  it("keeps an authoritative no-match quiet for the worktree session", () => {
    expect(
      reusableCommitAuthorIdentity({
        cacheState: "fresh",
        refreshState: "idle"
      })
    ).toBeNull();
  });
});
