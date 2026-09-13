import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const confirmDialog = vi.hoisted(() => vi.fn());
const showErrorToast = vi.hoisted(() => vi.fn());

vi.mock("../../lib/pwrgit", () => ({ dispatch }));
vi.mock("./dialogs", () => ({ confirmDialog }));
vi.mock("../../lib/toast", () => ({ showErrorToast }));

const {
  dirtySwitchMessage,
  guardedSwitchBranch,
  readDirtyState,
  switchWorktreeToBranch
} = await import("./branchSwitch");

const dirtyResult = (dirty: number) => ({
  ok: true as const,
  value: { dirty }
});

beforeEach(() => {
  dispatch.mockReset();
  confirmDialog.mockReset();
  showErrorToast.mockReset();
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
  it("says what carrying changes over means", () => {
    expect(dirtySwitchMessage({ kind: "dirty", files: 3 }, "PwrSnap", "main"))
      .toBe(
        "PwrSnap has 3 uncommitted changes. Switching to main carries them over to that branch instead of leaving them here."
      );
  });

  it("keeps the count singular for one file", () => {
    expect(
      dirtySwitchMessage({ kind: "dirty", files: 1 }, "PwrSnap", "main")
    ).toContain("1 uncommitted change.");
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
    branch: "feature/x"
  };

  it("switches without a dialog when the tree is clean", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(0))
      .mockResolvedValueOnce({ ok: true, value: null });
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched"
    });
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenLastCalledWith("branch:switch", {
      worktreeId: "wt-1",
      branch: "feature/x"
    });
  });

  it("confirms before carrying uncommitted changes over", async () => {
    dispatch
      .mockResolvedValueOnce(dirtyResult(4))
      .mockResolvedValueOnce({ ok: true, value: null });
    confirmDialog.mockResolvedValueOnce(true);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched"
    });
    expect(confirmDialog).toHaveBeenCalledOnce();
  });

  it("does not switch when the confirm is declined", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(4));
    confirmDialog.mockResolvedValueOnce(false);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "cancelled"
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("confirms when dirtiness could not be read", async () => {
    dispatch
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "git", code: "exit_128", message: "status failed" }
      })
      .mockResolvedValueOnce({ ok: true, value: null });
    confirmDialog.mockResolvedValueOnce(true);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched"
    });
    expect(confirmDialog).toHaveBeenCalledOnce();
  });

  // "Carry changes over" is the wrong question for a directory that does not
  // exist; the answer was a confirm followed by the switch's own refusal.
  it("refuses a gone checkout without offering to carry changes over", async () => {
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
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("skips the state read entirely when the caller already confirmed", async () => {
    dispatch.mockResolvedValueOnce({ ok: true, value: null });
    await expect(
      guardedSwitchBranch({ ...args, skipDirtyConfirm: true })
    ).resolves.toEqual({ kind: "switched" });
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
      .mockResolvedValueOnce({ ok: true, value: null });
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

  it("stays quiet when the dirty confirm is declined", async () => {
    dispatch.mockResolvedValueOnce(dirtyResult(3));
    confirmDialog.mockResolvedValueOnce(false);
    await expect(switchWorktreeToBranch(args)).resolves.toBe("cancelled");
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(onRevealWorktree).not.toHaveBeenCalled();
  });
});
