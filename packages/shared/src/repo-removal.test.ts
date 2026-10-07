import { describe, expect, it } from "vitest";
import {
  branchChoices,
  checkoutChoices,
  checkoutVerdict,
  removalStatus,
  type RemovalCheckout,
  type RemovalDecisions,
  type RepoRemovalReview
} from "./repo-removal";

const checkout = (over: Partial<RemovalCheckout> = {}): RemovalCheckout => ({
  worktreeId: "wt",
  branch: "feat/x",
  head: "abcdef1234",
  path: "/src/harbor-api-x",
  isPrimary: false,
  missing: false,
  locked: false,
  uncommitted: 0,
  untracked: 0,
  conflicted: 0,
  unpushed: 0,
  upstream: "origin/feat/x",
  inProgress: null,
  pushRemote: "origin",
  bytes: 100,
  bytesPartial: false,
  inspectError: null,
  ...over
});

const primary = (over: Partial<RemovalCheckout> = {}) =>
  checkout({
    worktreeId: "main",
    branch: "main",
    path: "/src/harbor-api",
    isPrimary: true,
    bytes: 1000,
    ...over
  });

const review = (over: Partial<RepoRemovalReview> = {}): RepoRemovalReview => ({
  repoId: "r",
  profileId: "p",
  name: "harbor-api",
  path: "/src/harbor-api",
  remotes: [{ name: "origin", url: "git@example.com:acme/harbor-api.git" }],
  checkouts: [checkout(), primary()],
  stashes: { count: 0, newestSubject: null, newestAt: null },
  branches: [],
  reviewedAt: "2026-10-01T00:00:00.000Z",
  ...over
});

const none: RemovalDecisions = { checkouts: {}, branches: {} };

describe("checkoutVerdict / checkoutChoices", () => {
  it("is safe with nothing to lose, and asks nothing", () => {
    expect(checkoutVerdict(checkout())).toBe("safe");
    expect(checkoutChoices(checkout())).toEqual([]);
  });

  it("blocks a locked checkout and a half-finished operation, which can only be kept", () => {
    expect(checkoutVerdict(checkout({ locked: true }))).toBe("blocked");
    expect(checkoutChoices(checkout({ inProgress: "rebase", uncommitted: 2 }))).toEqual([
      "keep"
    ]);
  });

  it("offers Push first only when unpushed commits are the whole risk", () => {
    expect(checkoutChoices(checkout({ unpushed: 2 }))).toEqual(["push", "keep", "discard"]);
    // Pushing would save the commits and lose the files.
    expect(checkoutChoices(checkout({ unpushed: 2, uncommitted: 3 }))).toEqual([
      "keep",
      "discard"
    ]);
    expect(checkoutChoices(checkout({ unpushed: 1, branch: "" }))).toEqual(["keep", "discard"]);
    expect(checkoutChoices(checkout({ unpushed: 1, pushRemote: null }))).toEqual([
      "keep",
      "discard"
    ]);
  });

  it("treats a missing folder and an inspection failure as at risk", () => {
    expect(checkoutVerdict(checkout({ missing: true }))).toBe("at_risk");
    expect(checkoutVerdict(checkout({ inspectError: "boom" }))).toBe("at_risk");
  });

  it("offers a loose branch Push first only when it has somewhere to go", () => {
    expect(branchChoices({ name: "b", unpushed: 1, pushRemote: "origin" })).toEqual([
      "push",
      "keep",
      "discard"
    ]);
    expect(branchChoices({ name: "b", unpushed: 1, pushRemote: null })).toEqual([
      "keep",
      "discard"
    ]);
  });
});

describe("removalStatus", () => {
  it("removes a clean repository with no questions and no name", () => {
    expect(removalStatus(review(), none)).toMatchObject({
      ready: true,
      partial: false,
      removePrimary: true,
      removeWorktreeIds: ["wt"],
      needsName: false,
      safe: 2,
      folderCount: 2,
      bytes: 1100
    });
  });

  it("counts every unanswered item, including those in the shared .git", () => {
    const status = removalStatus(
      review({
        checkouts: [checkout({ uncommitted: 1 }), primary({ unpushed: 1 })],
        stashes: { count: 2, newestSubject: "wip", newestAt: null },
        branches: [{ name: "spike", unpushed: 3, pushRemote: "origin" }]
      }),
      none
    );
    expect(status).toMatchObject({ undecided: 4, ready: false });
  });

  it("asks for the name when a full removal discards work, and lists what goes", () => {
    const status = removalStatus(
      review({
        checkouts: [
          checkout({ uncommitted: 3, unpushed: 2 }),
          checkout({ worktreeId: "gone", branch: "feat/gone", missing: true, bytes: null }),
          primary()
        ],
        stashes: { count: 2, newestSubject: "wip", newestAt: null },
        branches: [{ name: "spike", unpushed: 1, pushRemote: null }]
      }),
      {
        checkouts: { wt: "discard", gone: "discard" },
        stashes: "discard",
        branches: { spike: "discard" }
      }
    );
    expect(status).toMatchObject({ ready: true, needsName: true, folderCount: 2 });
    expect(status.discards).toEqual([
      "3 uncommitted files, 2 commits in feat/x",
      "the record of feat/gone",
      "2 stashes",
      "1 commit on spike"
    ]);
  });

  it("keeps the main checkout when anything that needs its .git is kept", () => {
    const base = review({
      checkouts: [checkout({ uncommitted: 1 }), primary()],
      stashes: { count: 1, newestSubject: "wip", newestAt: null }
    });
    const keptWorktree = removalStatus(base, { checkouts: { wt: "keep" }, branches: {} });
    // The stash no longer needs an answer: it stays with the main checkout.
    expect(keptWorktree).toMatchObject({
      partial: true,
      removePrimary: false,
      ready: false
    });
    const keptStash = removalStatus(base, {
      checkouts: { wt: "discard" },
      stashes: "keep",
      branches: {}
    });
    expect(keptStash).toMatchObject({
      partial: true,
      removePrimary: false,
      removeWorktreeIds: ["wt"],
      ready: true,
      // A partial removal never asks for the name.
      needsName: false,
      folderCount: 1
    });
  });

  it("will not start while a checkout is blocked, until it is kept", () => {
    const blocked = review({ checkouts: [checkout({ inProgress: "merge" }), primary()] });
    expect(removalStatus(blocked, none)).toMatchObject({ blocked: 1, ready: false });
    // Keeping it is the only way on, and makes the removal partial.
    expect(removalStatus(blocked, { checkouts: { wt: "keep" }, branches: {} })).toMatchObject({
      blocked: 0,
      partial: true,
      ready: false
    });
  });

  it("hands pushes back to the renderer and ignores answers that were never offered", () => {
    const status = removalStatus(
      review({
        checkouts: [checkout({ unpushed: 2 }), primary()],
        branches: [{ name: "spike", unpushed: 1, pushRemote: "origin" }]
      }),
      { checkouts: { wt: "push", main: "discard" }, branches: { spike: "push" } }
    );
    expect(status).toMatchObject({
      pushWorktreeIds: ["wt"],
      pushBranches: ["spike"],
      discards: [],
      ready: true
    });
    // "push" on a checkout that cannot push is no answer at all.
    expect(
      removalStatus(review({ checkouts: [checkout({ uncommitted: 1 }), primary()] }), {
        checkouts: { wt: "push" },
        branches: {}
      }).undecided
    ).toBe(1);
  });
});
