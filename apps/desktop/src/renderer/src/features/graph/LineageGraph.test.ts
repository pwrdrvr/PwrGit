import { describe, expect, it } from "vitest";
import {
  reusableCommitAuthorIdentity,
  shouldRequestCommitAuthorIdentity
} from "./LineageGraph";

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

  it("retries stale identities only after their persisted backoff gate", () => {
    expect(shouldRequestCommitAuthorIdentity(undefined, 1_000)).toBe(true);
    expect(
      shouldRequestCommitAuthorIdentity(
        { cacheState: "stale", refreshState: "in-flight" },
        1_000
      )
    ).toBe(false);
    expect(
      shouldRequestCommitAuthorIdentity(
        { cacheState: "stale", refreshState: "backing-off", nextRetryAt: 1_001 },
        1_000
      )
    ).toBe(false);
    expect(
      shouldRequestCommitAuthorIdentity(
        { cacheState: "stale", refreshState: "backing-off", nextRetryAt: 1_000 },
        1_000
      )
    ).toBe(true);
    expect(
      shouldRequestCommitAuthorIdentity(
        { cacheState: "fresh", refreshState: "idle" },
        1_000
      )
    ).toBe(false);
    expect(
      shouldRequestCommitAuthorIdentity(
        {
          cacheState: "fresh",
          refreshState: "idle",
          avatarCache: {
            cacheState: "miss",
            refreshState: "backing-off",
            nextRetryAt: 1_001
          }
        },
        1_000
      )
    ).toBe(false);
    expect(
      shouldRequestCommitAuthorIdentity(
        {
          cacheState: "fresh",
          refreshState: "idle",
          avatarCache: {
            cacheState: "miss",
            refreshState: "backing-off",
            nextRetryAt: 1_000
          }
        },
        1_000
      )
    ).toBe(true);
  });
});
