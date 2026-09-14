import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const chooseDialog = vi.hoisted(() => vi.fn());
const showErrorToast = vi.hoisted(() => vi.fn());
const nudgeToCommit = vi.hoisted(() => vi.fn());

vi.mock("../../lib/pwrgit", () => ({ dispatch }));
vi.mock("./dialogs", () => ({ chooseDialog }));
vi.mock("./commitNudge", () => ({ nudgeToCommit }));
vi.mock("../../lib/toast", () => ({ showErrorToast }));

const {
  askDirtyIntent,
  dirtyFacts,
  dirtySwitchMessage,
  guardedSwitchBranch,
  readDirtyState,
  switchWorktreeToBranch
} = await import("./branchSwitch");

/** `changes:list`, which the prompt reads to name the files at stake. */
const changeSet = (...paths: string[]) => ({
  ok: true as const,
  value: { staged: [], unstaged: paths.map((path) => ({ path })) }
});

const dirtyResult = (dirty: number) => ({
  ok: true as const,
  value: { dirty }
});

beforeEach(() => {
  dispatch.mockReset();
  chooseDialog.mockReset();
  showErrorToast.mockReset();
  nudgeToCommit.mockReset();
});

describe("readDirtyState", () => {
  it("reads a clean tree from the live checkout-safety probe", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(0));
    await expect(readDirtyState("wt-1")).resolves.toEqual({
      kind: "clean"
    });
    expect(dispatch).toHaveBeenCalledWith("worktree:readDirty", {
      worktreeId: "wt-1"
    });
  });

  it("counts parent and initialized-child changes", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(12));
    await expect(readDirtyState("wt-1")).resolves.toEqual({
      kind: "dirty",
      files: 12
    });
  });

  it("treats a failed read as unknown, not clean", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { kind: "repo", code: "not_found", message: "gone" }
    });
    await expect(readDirtyState("wt-1")).resolves.toEqual({
      kind: "unknown"
    });
  });
});

describe("dirtySwitchMessage", () => {
  // It asks rather than announces: the mechanism ("carries them over") is git
  // behaviour the reader would have to already know to predict the outcome of.
  it("asks what the changes were for", () => {
    expect(dirtySwitchMessage({ kind: "dirty", files: 3 }, "PwrSnap", "main"))
      .toBe(
        "PwrSnap has 3 uncommitted changes, and main is a different branch. What did you mean to do with them?"
      );
  });

  it("keeps the count singular for one file", () => {
    expect(
      dirtySwitchMessage({ kind: "dirty", files: 1 }, "PwrSnap", "main")
    ).toContain("1 uncommitted change,");
  });

  it("admits when it could not count", () => {
    expect(dirtySwitchMessage({ kind: "unknown" }, "PwrSnap", "main")).toContain(
      "uncommitted changes PwrGit could not count"
    );
  });
});

describe("guardedSwitchBranch", () => {
  const args = {
    worktreeId: "wt-1",
    worktreeLabel: "PwrSnap",
    fromBranch: "main",
    branch: "feature/x"
  };

  const switched = (carried: boolean) => ({
    ok: true as const,
    value: { carried }
  });
  /** The dispatch order on a dirty switch: probe, list the files, then act. */
  const dirtyRun = (files: number) =>
    dispatch
      .mockResolvedValueOnce(dirtyResult(files))
      .mockResolvedValueOnce(changeSet("a.ts", "b.ts"))
      .mockResolvedValueOnce(switched(true));

  it("switches without a prompt when the tree is clean", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(0)).mockResolvedValueOnce(switched(false));
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: false
    });
    expect(chooseDialog).not.toHaveBeenCalled();
    // No `carryChanges` on a clean tree: there is nothing to carry, and asking
    // main to stash anyway would cost two git commands to move nothing.
    expect(dispatch).toHaveBeenLastCalledWith("branch:switch", {
      worktreeId: "wt-1",
      branch: "feature/x"
    });
  });

  it("carries the changes when that is what the reader picked", async () => {
    dirtyRun(4);
    chooseDialog.mockResolvedValueOnce("carry");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: true
    });
    expect(chooseDialog).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenLastCalledWith("branch:switch", {
      worktreeId: "wt-1",
      branch: "feature/x",
      carryChanges: true
    });
  });

  // Cancelling and "commit first" both leave the checkout alone, and the caller
  // cannot tell them apart — but only one of them owes the reader a destination.
  it("does not switch when the prompt is dismissed", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(4))
      .mockResolvedValueOnce(changeSet("a.ts"));
    chooseDialog.mockResolvedValueOnce(null);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "cancelled"
    });
    expect(dispatch).not.toHaveBeenCalledWith("branch:switch", expect.anything());
    expect(nudgeToCommit).not.toHaveBeenCalled();
  });

  it("sends the reader to the commit box instead of switching", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(4))
      .mockResolvedValueOnce(changeSet("a.ts"));
    chooseDialog.mockResolvedValueOnce("commit_first");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "cancelled"
    });
    expect(nudgeToCommit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalledWith("branch:switch", expect.anything());
  });

  it("asks when dirtiness could not be read", async () => {
    dispatch
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "git", code: "exit_128", message: "status failed" }
      })
      .mockResolvedValueOnce(changeSet("a.ts"))
      .mockResolvedValueOnce(switched(true));
    chooseDialog.mockResolvedValueOnce("carry");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: true
    });
    expect(chooseDialog).toHaveBeenCalledOnce();
  });

  // The tree went clean between the probe and the operation. Reporting
  // `carried: true` there would credit a move that never happened.
  it("reports what main says was carried, not what the probe expected", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(4))
      .mockResolvedValueOnce(changeSet("a.ts"))
      .mockResolvedValueOnce(switched(false));
    chooseDialog.mockResolvedValueOnce("carry");
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched",
      carried: false
    });
  });

  // Every answer is the wrong question for a directory that does not exist:
  // there is nothing to switch and nothing to carry.
  it("refuses a gone checkout without asking anything", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "repo",
        code: "worktree_missing",
        message: "This worktree's folder no longer exists: /wt/gone."
      }
    });
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "failed",
      code: "worktree_missing",
      message: "This worktree's folder no longer exists: /wt/gone."
    });
    expect(chooseDialog).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("skips the state read entirely when the caller already asked", async () => {
    dispatch.mockResolvedValueOnce({ ok: true, value: { carried: false } });
    await expect(
      guardedSwitchBranch({ ...args, skipDirtyConfirm: true })
    ).resolves.toEqual({ kind: "switched", carried: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("branch:switch", {
      worktreeId: "wt-1",
      branch: "feature/x"
    });
  });

  // Occupancy is decided upstream from a refs snapshot that a second window or
  // a terminal can invalidate. A collision is therefore expected, not an error:
  // the caller goes to whichever worktree holds the branch now.
  it("reports a lost race as held rather than failed", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(0)).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "repo",
        code: "checked_out_elsewhere",
        message: "fatal: 'feature/x' is already used by worktree at '/repos/b'"
      }
    });
    await expect(guardedSwitchBranch(args)).resolves.toEqual({ kind: "held" });
  });

  it("passes any other refusal through with its code", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(0)).mockResolvedValueOnce({
      ok: false,
      error: { kind: "repo", code: "dirty", message: "would be overwritten" }
    });
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "failed",
      code: "dirty",
      message: "would be overwritten"
    });
  });
});

/**
 * The gesture every branch list now shares. The two outcomes worth pinning are
 * the ones that are NOT failures: a lost occupancy race resolves into a
 * navigation, and a declined dirty confirm leaves the world alone.
 */
describe("switchWorktreeToBranch", () => {
  const onRevealWorktree = vi.fn();
  const onRefs = vi.fn();
  const args = {
    repoId: "repo-1",
    worktreeId: "wt-1",
    worktreeLabel: "PwrSnap",
    fromBranch: "main",
    branch: "feature/x",
    onRevealWorktree,
    onRefs
  };

  const refsWith = (checkedOutWorktreeIds: string[]) => ({
    ok: true as const,
    value: {
      branches: [
        {
          name: "feature/x",
          fullName: "refs/heads/feature/x",
          head: "0".repeat(40),
          ahead: 0,
          behind: 0,
          tracking: "up_to_date",
          checkedOutWorktreeIds
        }
      ],
      previewTags: [],
      tagCount: 0,
      remotes: []
    }
  });

  beforeEach(() => {
    onRevealWorktree.mockReset();
    onRefs.mockReset();
  });

  it("reports a clean switch and raises nothing", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(0))
      .mockResolvedValueOnce({ ok: true, value: { carried: false } });
    await expect(switchWorktreeToBranch(args)).resolves.toBe("switched");
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(onRevealWorktree).not.toHaveBeenCalled();
  });

  // The whole point of resolving `held` here: git refuses the second checkout,
  // and its refusal names a path, not an id — so the fresh snapshot is what
  // turns "someone else has it" into "go here".
  it("takes the caller to whoever holds the branch now", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(0))
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "repo",
          code: "checked_out_elsewhere",
          message: "fatal: already used by worktree at '/repos/b'"
        }
      })
      .mockResolvedValueOnce(refsWith(["wt-2"]));
    await expect(switchWorktreeToBranch(args)).resolves.toBe("revealed");
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-2");
    expect(onRefs).toHaveBeenCalledOnce();
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  // The re-read is not free, and the caller is holding the snapshot it just
  // invalidated — handing it back is what keeps the row states honest.
  it("hands the refreshed snapshot back to the caller", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(0))
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "repo", code: "checked_out_elsewhere", message: "held" }
      })
      .mockResolvedValueOnce(refsWith(["wt-2"]));
    await switchWorktreeToBranch(args);
    expect(onRefs.mock.calls[0]?.[0]?.branches?.[0]?.name).toBe("feature/x");
  });

  // A branch that was held a moment ago and is held by nobody now means the
  // snapshot moved under us twice. There is no worktree to go to, so say so.
  it("falls back to a message when the holder has since vanished", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(0))
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "repo", code: "checked_out_elsewhere", message: "held" }
      })
      .mockResolvedValueOnce(refsWith([]));
    await expect(switchWorktreeToBranch(args)).resolves.toBe("failed");
    expect(onRevealWorktree).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledOnce();
  });

  it("translates a dirty refusal into what the reader has to do", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(0)).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "repo",
        code: "dirty",
        message: "error: Your local changes would be overwritten"
      }
    });
    await expect(switchWorktreeToBranch(args)).resolves.toBe("failed");
    expect(showErrorToast.mock.calls[0]?.[0]?.message).toContain(
      "Commit or stash them first"
    );
  });

  it("stays quiet when the dirty prompt is dismissed", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(3))
      .mockResolvedValueOnce(changeSet("a.ts"));
    chooseDialog.mockResolvedValueOnce(null);
    await expect(switchWorktreeToBranch(args)).resolves.toBe("cancelled");
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(onRevealWorktree).not.toHaveBeenCalled();
  });
});

/**
 * The question itself. Its whole job is to name the three things the reader
 * might have meant, so the wording is the feature — a choice labelled with a
 * git mechanism instead of an intent is the defect this replaced.
 */
describe("askDirtyIntent", () => {
  const ask = (from = "main") =>
    askDirtyIntent({ kind: "dirty", files: 3 }, "PwrSnap", from, "feature/x", [
      "src/a.ts"
    ]);

  it("offers both destinations by name, and what each one costs", async () => {
    chooseDialog.mockResolvedValueOnce("carry");
    await ask();
    const opts = chooseDialog.mock.calls[0]?.[0];
    expect(opts.title).toBe("Switch to feature/x?");
    expect(opts.facts).toEqual(["src/a.ts"]);
    expect(opts.choices.map((c: { label: string }) => c.label)).toEqual([
      "Bring them to feature/x",
      "Commit on main first"
    ]);
    // The promise the carrying switch is built to keep, stated before the
    // reader commits to it rather than discovered afterwards.
    expect(opts.choices[0].detail).toContain("nothing moves");
    expect(opts.choices[0].detail).toContain("you stay on main");
  });

  it.each([
    ["carry", "carry"],
    ["commit_first", "commit_first"]
  ])("passes %s through", async (answer, expected) => {
    chooseDialog.mockResolvedValueOnce(answer);
    await expect(ask()).resolves.toBe(expected);
  });

  // Escape, the backdrop, and the Cancel button all arrive as null.
  it("treats a dismissed prompt as cancel", async () => {
    chooseDialog.mockResolvedValueOnce(null);
    await expect(ask()).resolves.toBe("cancel");
  });

  // `Worktree.branch` is not always a branch name. "Commit on detached@ab12 first"
  // would be printing a sentinel at the reader as if it were one.
  it.each(["detached@ab12cd", "(bare)", "(unknown)"])(
    "does not print the %s sentinel as a branch",
    async (sentinel) => {
      chooseDialog.mockResolvedValueOnce(null);
      await ask(sentinel);
      const opts = chooseDialog.mock.calls[0]?.[0];
      expect(opts.choices[1].label).toBe("Commit on this checkout first");
      expect(opts.choices[0].detail).toContain("you stay on this checkout");
    }
  );
});

describe("dirtyFacts", () => {
  it("names the files at stake, staged ones first", async () => {
    dispatch.mockResolvedValueOnce({
      ok: true,
      value: {
        staged: [{ path: "src/staged.ts" }],
        unstaged: [{ path: "src/loose.ts" }]
      }
    });
    await expect(dirtyFacts("wt-1")).resolves.toEqual([
      "src/staged.ts",
      "src/loose.ts"
    ]);
  });

  // A file that is both staged and further modified is one file to the reader.
  it("counts a partially staged file once", async () => {
    dispatch.mockResolvedValueOnce({
      ok: true,
      value: { staged: [{ path: "both.ts" }], unstaged: [{ path: "both.ts" }] }
    });
    await expect(dirtyFacts("wt-1")).resolves.toEqual(["both.ts"]);
  });

  // `changes:list` caps its rows and carries the real totals in `truncated`.
  // Counting the remainder off the capped array undercounts exactly when the
  // number matters — a regenerated lockfile, a reformatted tree.
  it("counts the overflow from the real totals, not the capped rows", async () => {
    dispatch.mockResolvedValueOnce({
      ok: true,
      value: {
        staged: [],
        unstaged: ["a", "b", "c", "d", "e", "f"].map((path) => ({ path })),
        truncated: { staged: 0, unstaged: 500, largestUntrackedFolder: null }
      }
    });
    await expect(dirtyFacts("wt-1", 5)).resolves.toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "…and 495 more"
    ]);
  });

  it("says how many it is not listing", async () => {
    dispatch.mockResolvedValueOnce(
      changeSet("a", "b", "c", "d", "e", "f", "g")
    );
    await expect(dirtyFacts("wt-1", 5)).resolves.toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "…and 2 more"
    ]);
  });

  // Best-effort: losing the list must not lose the prompt, which is the part
  // that actually protects the work.
  it("costs the list and not the prompt when it cannot be read", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { kind: "git", code: "exit_128", message: "no" }
    });
    await expect(dirtyFacts("wt-1")).resolves.toEqual([]);
  });
});
