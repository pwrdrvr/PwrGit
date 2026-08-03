import { describe, expect, it } from "vitest";
import {
  mergeCommitAuthorIdentityLookup,
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

describe("mergeCommitAuthorIdentityLookup", () => {
  it("accepts a completed cache-only reply when an event is unavailable", () => {
    expect(
      mergeCommitAuthorIdentityLookup(undefined, {
        identity: {
          login: "huntharo",
          avatarUrl: "pwrgit-avatar://thumbnail/a?v=1"
        },
        cacheState: "fresh",
        refreshState: "idle",
        refreshedAt: 1_000
      })
    ).toMatchObject({
      identity: { login: "huntharo" },
      cacheState: "fresh"
    });
  });

  it("does not let an older optimistic reply erase an identity already received", () => {
    const current = {
      identity: {
        login: "huntharo",
        avatarUrl: "pwrgit-avatar://thumbnail/a?v=2"
      },
      cacheState: "fresh" as const,
      refreshState: "idle" as const,
      refreshedAt: 2_000
    };

    expect(
      mergeCommitAuthorIdentityLookup(current, {
        cacheState: "miss",
        refreshState: "in-flight"
      })
    ).toBe(current);
  });

  it("does not let an optimistic reply erase a fresh no-match", () => {
    const current = { cacheState: "fresh" as const, refreshState: "idle" as const };

    expect(
      mergeCommitAuthorIdentityLookup(current, {
        cacheState: "miss",
        refreshState: "in-flight"
      })
    ).toBe(current);
  });

  it("keeps a newer thumbnail event over an older completed cache reply", () => {
    const current = {
      identity: {
        login: "huntharo",
        avatarUrl: "pwrgit-avatar://thumbnail/a?v=2"
      },
      cacheState: "fresh" as const,
      refreshState: "idle" as const,
      refreshedAt: 1_000,
      avatarCache: {
        cacheState: "stale" as const,
        refreshState: "in-flight" as const,
        refreshedAt: 2_000
      }
    };

    expect(
      mergeCommitAuthorIdentityLookup(current, {
        identity: {
          login: "huntharo",
          avatarUrl: "pwrgit-avatar://thumbnail/a?v=1"
        },
        cacheState: "fresh",
        refreshState: "idle",
        refreshedAt: 1_000,
        avatarCache: {
          cacheState: "stale",
          refreshState: "in-flight",
          refreshedAt: 1_000
        }
      })
    ).toBe(current);
  });
});
