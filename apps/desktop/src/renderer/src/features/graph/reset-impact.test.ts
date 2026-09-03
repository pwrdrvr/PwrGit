import { describe, expect, it } from "vitest";
import type {
  DivergenceCommit,
  DivergenceCommitAlignment,
  RemoteResetPreview
} from "@pwrgit/shared";
import {
  fetchAgeLabel,
  isStaleFetch,
  remoteRefLabel,
  resetImpact,
  STALE_FETCH_MS,
  targetNote
} from "./reset-impact";

function commit(shortHash: string, subject: string): DivergenceCommit {
  return {
    hash: shortHash.padEnd(40, "0"),
    shortHash,
    subject,
    additions: 3,
    deletions: 1
  };
}

function preview(
  alignedCommits: DivergenceCommitAlignment[],
  dirty = 0
): RemoteResetPreview {
  return {
    snapshot: {
      branch: "fix/media-copy",
      head: "1".repeat(40),
      remoteRef: "refs/remotes/origin/fix/media-copy",
      remoteHead: "2".repeat(40)
    },
    leaving: alignedCommits
      .map((row) => row.local)
      .filter((row): row is DivergenceCommit => row !== null),
    arriving: alignedCommits
      .map((row) => row.upstream)
      .filter((row): row is DivergenceCommit => row !== null),
    alignedCommits,
    dirty
  };
}

describe("resetImpact", () => {
  it("counts a rebased-and-force-pushed upstream as nothing stranded", () => {
    // Every hash differs, which is exactly what a plain ahead/behind count
    // reports as total loss. Git matched them all, so nothing is lost.
    const impact = resetImpact(
      preview([
        {
          local: commit("aaa1111", "add media copy"),
          upstream: commit("bbb2222", "add media copy"),
          relation: "equivalent"
        },
        {
          local: commit("aaa3333", "cover the HDROP path"),
          upstream: commit("bbb4444", "cover the HDROP path"),
          relation: "changed"
        }
      ]),
      "hard"
    );

    expect(impact.leaving).toBe(2);
    expect(impact.rewritten).toBe(2);
    expect(impact.stranded).toBe(0);
    expect(impact.arriving).toBe(2);
    expect(impact.needsAcknowledgement).toBe(false);
  });

  it("counts only the unmatched local commits as stranded", () => {
    const impact = resetImpact(
      preview([
        {
          local: commit("aaa1111", "add media copy"),
          upstream: commit("bbb2222", "add media copy"),
          relation: "equivalent"
        },
        {
          local: commit("aaa5555", "wip: never pushed"),
          upstream: null,
          relation: "local-only"
        },
        {
          local: null,
          upstream: commit("bbb6666", "someone else's fix"),
          relation: "upstream-only"
        }
      ]),
      "soft"
    );

    expect(impact.leaving).toBe(2);
    expect(impact.stranded).toBe(1);
    expect(impact.rewritten).toBe(1);
    expect(impact.arriving).toBe(2);
  });

  it("weighs the working tree only against a hard reset", () => {
    const stranded = preview(
      [{ local: commit("aaa5555", "wip"), upstream: null, relation: "local-only" }],
      4
    );

    // Soft moves the pointer and leaves the content behind as a diff, so the
    // same stranded commit is not the same decision.
    expect(resetImpact(stranded, "soft")).toMatchObject({
      discarding: 0,
      needsAcknowledgement: false
    });
    expect(resetImpact(stranded, "hard")).toMatchObject({
      discarding: 4,
      needsAcknowledgement: true
    });
  });

  it("asks for no acknowledgement when a hard reset strands nothing", () => {
    const impact = resetImpact(
      preview([
        {
          local: null,
          upstream: commit("bbb6666", "fast-forward material"),
          relation: "upstream-only"
        }
      ]),
      "hard"
    );

    expect(impact.stranded).toBe(0);
    expect(impact.needsAcknowledgement).toBe(false);
  });
});

describe("fetchAgeLabel", () => {
  const now = Date.parse("2026-09-01T15:00:00.000Z");
  const ago = (ms: number): string => new Date(now - ms).toISOString();

  it("keeps minute resolution inside the hour", () => {
    expect(fetchAgeLabel(ago(20_000), now)).toBe("moments ago");
    expect(fetchAgeLabel(ago(6 * 60_000), now)).toBe("6m ago");
    expect(fetchAgeLabel(ago(59 * 60_000), now)).toBe("59m ago");
  });

  it("carries the minutes past an hour — 2h and 2h 59m are not the same", () => {
    expect(fetchAgeLabel(ago(2 * 3_600_000), now)).toBe("2h ago");
    expect(fetchAgeLabel(ago(2 * 3_600_000 + 16 * 60_000), now)).toBe(
      "2h 16m ago"
    );
  });

  it("falls back to days, and says so when the timestamp is unusable", () => {
    expect(fetchAgeLabel(ago(3 * 86_400_000), now)).toBe("3d ago");
    expect(fetchAgeLabel("not a date", now)).toBe("at an unknown time");
  });
});

describe("isStaleFetch", () => {
  const now = Date.parse("2026-09-01T15:00:00.000Z");

  it("treats a repository that has never fetched as stale", () => {
    expect(isStaleFetch(null, now)).toBe(true);
  });

  it("splits on the staleness window", () => {
    const fresh = new Date(now - STALE_FETCH_MS + 1_000).toISOString();
    const old = new Date(now - STALE_FETCH_MS - 1_000).toISOString();
    expect(isStaleFetch(fresh, now)).toBe(false);
    expect(isStaleFetch(old, now)).toBe(true);
  });
});

describe("targetNote", () => {
  it("names the shape of the move, not just the numbers", () => {
    expect(targetNote(9, 15)).toBe("Diverged: 9 commits of yours leave, 15 arrive.");
    expect(targetNote(0, 15)).toBe(
      "Fast-forward: 15 commits arrive, none of yours leave."
    );
    expect(targetNote(1, 0)).toBe(
      "1 commit of yours leaves the branch; nothing arrives."
    );
    expect(targetNote(0, 1)).toBe(
      "Fast-forward: 1 commit arrives, none of yours leave."
    );
  });

  it("does not describe an identical branch as a divergence", () => {
    expect(targetNote(0, 0)).toBe("Already identical to this branch.");
  });
});

describe("remoteRefLabel", () => {
  it("shortens a fetched ref to what the picker shows", () => {
    expect(remoteRefLabel("refs/remotes/origin/fix/media-copy")).toBe(
      "origin/fix/media-copy"
    );
    expect(remoteRefLabel("origin/main")).toBe("origin/main");
  });
});
