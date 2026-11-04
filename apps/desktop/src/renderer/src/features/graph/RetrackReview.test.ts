import { describe, expect, it } from "vitest";
import type { RetrackReview, TrackingOption } from "@pwrgit/shared";
import { retrackChoices, retrackCommand, retrackShape } from "./RetrackReview";
import { forkMovedOn } from "./pull-choice";

const target = (ahead: number, behind: number): TrackingOption => ({
  remote: "pwrdisk",
  remoteBranch: "main",
  ref: "pwrdisk/main",
  head: "2".repeat(40),
  ahead,
  behind,
  tracked: false
});
const review = (over: Partial<RetrackReview> & { target: TrackingOption }): RetrackReview => ({
  branch: "main",
  head: "1".repeat(40),
  upstreamRef: "refs/remotes/origin/main",
  from: null,
  unpushed: 0,
  leavingOn: null,
  arriving: [],
  checkout: { kind: "here", dirty: 0 },
  pushOverride: null,
  copyName: "main-before-pwrdisk",
  ...over
});

describe("retrackChoices", () => {
  it("asks nothing for a fast-forward or the same commit", () => {
    expect(retrackShape(target(0, 2))).toBe("forward");
    expect(retrackChoices(review({ target: target(0, 2) }))).toEqual([]);
    expect(retrackChoices(review({ target: target(0, 0) }))).toEqual([]);
  });

  it("offers keeping the tip first, and moving it only where the commits stay reachable", () => {
    const onUpstream = retrackChoices(review({ target: target(2, 0), leavingOn: "origin/main" }));
    expect(onUpstream.map((c) => [c.key, c.move, c.copy])).toEqual([
      ["keep", "none", false],
      ["move", "reset", false]
    ]);
    expect(onUpstream[1]?.detail).toBe("The 2 commits leave main and remain on origin/main.");
  });

  it("keeps a copy when a leaving commit is on no remote", () => {
    const [, move] = retrackChoices(review({ target: target(1, 3), unpushed: 1 }));
    expect(move).toMatchObject({ move: "reset", copy: true, title: "Move main to pwrdisk/main, keep a copy" });
    expect(retrackCommand(review({ target: target(1, 3), unpushed: 1 }), move ?? null)).toBe(
      "git branch main-before-pwrdisk main · git reset --keep 2222222 · git branch --set-upstream-to=pwrdisk/main main"
    );
  });

  it("only tracks a branch another worktree holds", () => {
    const held = review({ target: target(1, 1), checkout: { kind: "elsewhere", path: "/w/other" } });
    expect(retrackChoices(held)).toEqual([]);
    expect(retrackCommand(held, null)).toBe("git branch --set-upstream-to=pwrdisk/main main");
  });

  it("moves a free branch with a ref update", () => {
    expect(retrackCommand(review({ target: target(0, 2), checkout: { kind: "free" } }), null)).toBe(
      "git update-ref refs/heads/main 2222222 · git branch --set-upstream-to=pwrdisk/main main"
    );
  });
});

describe("forkMovedOn", () => {
  const pushBack = (adds: number, overwrites: number) => ({ adds, overwrites });
  it("is the fork ahead of a source with nothing new", () => {
    expect(forkMovedOn({ behind: 0, pushBack: pushBack(0, 7) })).toBe(true);
  });
  it("is not a source with something to bring in, or a fork level with it", () => {
    expect(forkMovedOn({ behind: 3, pushBack: pushBack(0, 7) })).toBe(false);
    expect(forkMovedOn({ behind: 0, pushBack: pushBack(2, 7) })).toBe(false);
    expect(forkMovedOn({ behind: 0, pushBack: pushBack(0, 0) })).toBe(false);
    expect(forkMovedOn({ behind: 0, pushBack: null })).toBe(false);
  });
});
