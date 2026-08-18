import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const confirmDialog = vi.hoisted(() => vi.fn());
/** Handlers registered by the code under test, so a test can fire the
 *  `worktree:changed` a real refresh would emit. */
const listeners = vi.hoisted(() => new Set<(p: { worktreeId: string }) => void>());
const subscribe = vi.hoisted(() => (_channel: string, handler: (p: { worktreeId: string }) => void) => {
  listeners.add(handler);
  return () => listeners.delete(handler);
});

vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));
vi.mock("./dialogs", () => ({ confirmDialog }));

/** Stand in for the main process finishing the refresh `worktree:getState`
 *  kicks off. Deferred a tick so it lands while the wait is pending. */
function emitWorktreeChanged(worktreeId: string): void {
  queueMicrotask(() => {
    for (const handler of [...listeners]) handler({ worktreeId });
  });
}

/** Short, so a test that genuinely waits out the window does not sit for 5s. */
const WAIT_MS = 20;

const {
  dirtySwitchMessage,
  guardedSwitchBranch,
  readDirtyState
} = await import("./branchSwitch");

function stateResult(dirty: number | null) {
  return {
    ok: true as const,
    value:
      dirty === null
        ? null
        : {
            worktreeId: "wt-1",
            branch: "main",
            head: "0".repeat(40),
            hasUpstream: true,
            ahead: 0,
            behind: 0,
            dirty,
            behindDefault: 0,
            defaultBranch: "main",
            mergedIntoDefault: false,
            divergedFromDefault: false,
            isDefaultBranch: true,
            updatedAt: "2026-08-18T00:00:00.000Z"
          }
  };
}

beforeEach(() => {
  dispatch.mockReset();
  confirmDialog.mockReset();
  listeners.clear();
});

describe("readDirtyState", () => {
  it("reads a clean tree from a live snapshot", async () => {
    dispatch.mockResolvedValueOnce(stateResult(0));
    await expect(readDirtyState("wt-1", WAIT_MS)).resolves.toEqual({
      kind: "clean"
    });
  });

  it("counts changed files", async () => {
    dispatch.mockResolvedValueOnce(stateResult(12));
    await expect(readDirtyState("wt-1", WAIT_MS)).resolves.toEqual({
      kind: "dirty",
      files: 12
    });
  });

  // `worktree:getState` answers from cache and only KICKS OFF a refresh, so the
  // first read of a freshly added repo misses. Treating that as unknown would
  // prompt about uncountable changes on a clean tree — the exact spurious
  // confirm that broke the Windows e2e run.
  it("waits for the refresh a cache miss kicks off, then re-reads", async () => {
    dispatch
      .mockImplementationOnce(async () => {
        emitWorktreeChanged("wt-1");
        return stateResult(null);
      })
      .mockResolvedValueOnce(stateResult(0));
    await expect(readDirtyState("wt-1", WAIT_MS)).resolves.toEqual({
      kind: "clean"
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("ignores a change for a different worktree", async () => {
    dispatch.mockImplementationOnce(async () => {
      emitWorktreeChanged("wt-other");
      return stateResult(null);
    });
    await expect(readDirtyState("wt-1", WAIT_MS)).resolves.toEqual({
      kind: "unknown"
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  // The whole reason this reads a live snapshot instead of the `dirty` already
  // on the Worktree in the repo tree: that field is `w.dirty ?? 0` over a LEFT
  // JOIN written lazily, so "no state row" is indistinguishable from "clean"
  // there. Here it must be unknown, never clean.
  it("treats a snapshot that never arrives as unknown, not clean", async () => {
    dispatch.mockResolvedValueOnce(stateResult(null));
    await expect(readDirtyState("wt-1", WAIT_MS)).resolves.toEqual({
      kind: "unknown"
    });
  });

  it("treats a snapshot still missing after the refresh as unknown", async () => {
    dispatch
      .mockImplementationOnce(async () => {
        emitWorktreeChanged("wt-1");
        return stateResult(null);
      })
      .mockResolvedValueOnce(stateResult(null));
    await expect(readDirtyState("wt-1", WAIT_MS)).resolves.toEqual({
      kind: "unknown"
    });
  });

  it("treats a failed read as unknown, not clean", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { kind: "repo", code: "not_found", message: "gone" }
    });
    await expect(readDirtyState("wt-1", WAIT_MS)).resolves.toEqual({
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
    branch: "feature/x",
    snapshotWaitMs: WAIT_MS
  };

  it("switches without a dialog when the tree is clean", async () => {
    dispatch
      .mockResolvedValueOnce(stateResult(0))
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
      .mockResolvedValueOnce(stateResult(4))
      .mockResolvedValueOnce({ ok: true, value: null });
    confirmDialog.mockResolvedValueOnce(true);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched"
    });
    expect(confirmDialog).toHaveBeenCalledOnce();
  });

  it("does not switch when the confirm is declined", async () => {
    dispatch.mockResolvedValueOnce(stateResult(4));
    confirmDialog.mockResolvedValueOnce(false);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "cancelled"
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("confirms when dirtiness could not be read", async () => {
    dispatch
      .mockResolvedValueOnce(stateResult(null))
      .mockResolvedValueOnce({ ok: true, value: null });
    confirmDialog.mockResolvedValueOnce(true);
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "switched"
    });
    expect(confirmDialog).toHaveBeenCalledOnce();
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
    dispatch.mockResolvedValueOnce(stateResult(0)).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "repo",
        code: "checked_out_elsewhere",
        message: "fatal: 'feature/x' is already used by worktree at '/repos/b'"
      }
    });
    await expect(guardedSwitchBranch(args)).resolves.toEqual({
      kind: "held",
      worktreeId: null
    });
  });

  it("passes any other refusal through with its code", async () => {
    dispatch.mockResolvedValueOnce(stateResult(0)).mockResolvedValueOnce({
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
