import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Result, type Res } from "@pwrgit/shared";
import { RemoteTipChecker, REMOTE_VISIBLE_DEBOUNCE_MS, REMOTE_VISIBLE_INTERVAL_MS, type RemoteCheckReason, type RemoteCheckRequest } from "./remote-tip-checker";

describe("RemoteTipChecker", () => {
  let checker: RemoteTipChecker;
  let focused: boolean;
  const check = vi.fn(async (_id: string, _request: { reason: RemoteCheckReason; userAction: boolean }): Promise<Result<Res<"remote:checkSelected">>> => ok({ status: "checked" }));
  const checkBatch = async (ids: string[], request: RemoteCheckRequest) =>
    new Map(await Promise.all(ids.map(async (id) => [id, await check(id, request)] as const)));
  beforeEach(() => {
    vi.useFakeTimers();
    check.mockReset();
    check.mockResolvedValue(ok({ status: "checked" }));
    focused = true;
    checker = new RemoteTipChecker({ check: checkBatch, isFocused: () => focused });
  });
  afterEach(() => { checker.stop(); vi.useRealTimers(); });
  const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_DEBOUNCE_MS); };

  it("checks only the five rows left visible after scrolling past 120 repositories", async () => {
    for (let i = 0; i < 120; i += 5) {
      checker.report(1, Array.from({ length: 5 }, (_, j) => `repo-${i + j}`));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(check).not.toHaveBeenCalled();
    await settle();
    expect(check.mock.calls.map(([id]) => id)).toEqual(["repo-115", "repo-116", "repo-117", "repo-118", "repo-119"]);
    expect(check).toHaveBeenCalledWith("repo-119", { reason: "visible", userAction: true });
  });

  it("keeps the 60-second cooldown across repeated scrolling and focus changes", async () => {
    checker.report(1, ["a"]);
    await settle();
    for (let i = 0; i < 5; i += 1) {
      checker.report(1, []);
      await vi.advanceTimersByTimeAsync(5_000);
      checker.report(1, ["a"]);
      checker.focus();
      await settle();
    }
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_INTERVAL_MS);
    checker.tick();
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("remembers a check that finishes after its row leaves view", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    check.mockImplementation(async () => { await gate; return ok({ status: "checked" }); });
    checker.report(1, ["a"]);
    await settle();
    checker.report(1, []);
    release();
    await settle();
    checker.report(1, ["a"]);
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each(["selected", "hover"] as const)("allows %s to refresh inside the viewport cooldown", async (reason) => {
    checker.report(1, ["a"]);
    await settle();
    expect(await checker.request("a", reason).result).toEqual(ok({ status: "checked" }));
    expect(check).toHaveBeenCalledTimes(2);
    checker.report(1, []);
    checker.report(1, ["a"]);
    checker.focus();
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps freshness separate across branch changes", async () => {
    checker.stop();
    let branch = "main";
    checker = new RemoteTipChecker({ check: checkBatch, isFocused: () => focused, keyFor: (id) => `${id}/${branch}` });
    checker.report(1, ["a"]);
    await settle();
    branch = "topic";
    checker.report(1, ["a"]);
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("drops a debounced periodic check if an explicit check already refreshed it", async () => {
    const periodic = checker.request("a", "periodic");
    expect(await checker.request("a", "selected").result).toEqual(ok({ status: "checked" }));
    await settle();
    expect(await periodic.result).toEqual(ok({ status: "superseded" }));
    const repeated = checker.request("a", "periodic");
    await settle();
    expect(await repeated.result).toEqual(ok({ status: "checked" }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["hover", "checked", "unavailable"],
    ["hover", "unavailable", "checked"],
    ["visible", "checked", "unavailable"],
    ["visible", "unavailable", "checked"]
  ] as const)("returns the latest %s answer after %s changes to %s", async (reason, before, after) => {
    check.mockResolvedValueOnce(ok({ status: before })).mockResolvedValueOnce(ok({ status: after }));
    expect(await checker.request("a", "selected").result).toEqual(ok({ status: before }));
    if (reason === "visible") await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_INTERVAL_MS);
    const refreshed = checker.request("a", reason);
    await settle();
    expect(await refreshed.result).toEqual(ok({ status: after }));
    const periodic = checker.request("a", "periodic");
    await settle();
    expect(await periodic.result).toEqual(ok({ status: after }));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("returns a thrown check's unavailable answer without extending the cooldown", async () => {
    check.mockRejectedValueOnce(new Error("offline"));
    expect(await checker.request("a", "hover").result).toEqual(ok({ status: "unavailable" }));
    await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_INTERVAL_MS - 2 * REMOTE_VISIBLE_DEBOUNCE_MS);
    const cached = checker.request("a", "periodic");
    await settle();
    expect(await cached.result).toEqual(ok({ status: "unavailable" }));
    expect(check).toHaveBeenCalledTimes(1);
    const expired = checker.request("a", "periodic");
    await settle();
    expect(await expired.result).toEqual(ok({ status: "checked" }));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not share completed answers across profile worktrees or branches", async () => {
    checker.stop();
    let branch = "main";
    checker = new RemoteTipChecker({ check: checkBatch, isFocused: () => focused, keyFor: (id) => `${id}/${branch}` });
    check.mockResolvedValueOnce(ok({ status: "unavailable" }));
    expect(await checker.request("profile-a/worktree", "selected").result).toEqual(ok({ status: "unavailable" }));
    const otherProfile = checker.request("profile-b/worktree", "periodic");
    await settle();
    expect(await otherProfile.result).toEqual(ok({ status: "checked" }));
    branch = "topic";
    const otherBranch = checker.request("profile-a/worktree", "periodic");
    await settle();
    expect(await otherBranch.result).toEqual(ok({ status: "checked" }));
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("discards a queued request for a branch the checkout no longer holds", async () => {
    checker.stop();
    let branch = "main";
    checker = new RemoteTipChecker({ check: checkBatch, isFocused: () => focused, keyFor: (id) => `${id}/${branch}` });
    const stale = checker.request("a", "visible");
    branch = "topic";
    await settle();
    expect(await stale.result).toEqual(ok({ status: "superseded" }));
    expect(check).not.toHaveBeenCalled();
    checker.report(1, ["a"]);
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("caps background work at four and discards cancelled queued checks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    check.mockImplementation(async () => { await gate; return ok({ status: "checked" }); });
    checker.report(1, ["a", "b", "c", "d", "cancel-me", "keep-me"]);
    await settle();
    expect(check).toHaveBeenCalledTimes(4);
    checker.report(1, ["a", "b", "c", "d", "keep-me"]);
    release();
    await settle();
    expect(check.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "d", "keep-me"]);
  });

  it.each(["visible", "focus", "periodic"] as const)(
    "settles a %s check skipped after focus is lost during debounce and allows retry",
    async (reason) => {
      const handle = checker.request("a", reason);
      focused = false;
      await settle();
      expect(check).not.toHaveBeenCalled();
      expect(await handle.result).toEqual(ok({ status: "superseded" }));
      focused = true;
      const retry = checker.request("a", reason);
      await settle();
      expect(await retry.result).toEqual(ok({ status: "checked" }));
      expect(check).toHaveBeenCalledTimes(1);
    }
  );

  it("skips queued viewport checks after focus is lost without marking them fresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    check.mockImplementation(async () => { await gate; return ok({ status: "checked" }); });
    checker.report(1, ["a", "b", "c", "d", "waiting-a", "waiting-b"]);
    await settle();
    expect(check).toHaveBeenCalledTimes(4);
    const waiting = ["waiting-a", "waiting-b"].map((id) => checker.request(id, "visible"));
    focused = false;
    release();
    await settle();
    expect(check).toHaveBeenCalledTimes(4);
    expect(await Promise.all(waiting.map((handle) => handle.result)))
      .toEqual([ok({ status: "superseded" }), ok({ status: "superseded" })]);
    focused = true;
    checker.tick();
    await settle();
    expect(check.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "d", "waiting-a", "waiting-b"]);
  });

  it("reschedules visible rows when focus returns after their checks were skipped", async () => {
    checker.report(1, ["a"]);
    focused = false;
    await settle();
    expect(check).not.toHaveBeenCalled();
    focused = true;
    checker.focus();
    await settle();
    expect(check).toHaveBeenCalledExactlyOnceWith("a", { reason: "focus", userAction: true });
  });

  it.each(["selected", "hover"] as const)(
    "allows %s to promote queued viewport work even after focus is lost",
    async (reason) => {
      checker.report(1, ["a"]);
      focused = false;
      expect(await checker.request("a", reason).result).toEqual(ok({ status: "checked" }));
      await settle();
      expect(check).toHaveBeenCalledExactlyOnceWith("a", { reason, userAction: true });
    }
  );

  it("promotes hover ahead of a saturated background lane and cancels its old queued copy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    check.mockImplementation(async (id) => {
      if (id !== "hovered") await gate;
      return ok({ status: "checked" });
    });
    checker.report(1, ["a", "b", "c", "d", "hovered"]);
    await settle();
    expect(check).toHaveBeenCalledTimes(4);
    expect(await checker.request("hovered", "hover").result).toEqual(ok({ status: "checked" }));
    expect(check).toHaveBeenLastCalledWith("hovered", { reason: "hover", userAction: true });
    release();
    await settle();
    expect(check).toHaveBeenCalledTimes(5);
  });

  it("distinguishes periodic checks from focus and viewport user actions", async () => {
    checker.report(1, ["a"]);
    await settle();
    checker.tick();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_INTERVAL_MS);
    focused = false;
    checker.tick();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    focused = true;
    checker.focus();
    await settle();
    expect(check).toHaveBeenLastCalledWith("a", { reason: "focus", userAction: true });
    await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_INTERVAL_MS);
    checker.tick();
    await settle();
    expect(check).toHaveBeenLastCalledWith("a", { reason: "periodic", userAction: false });
  });

  it("keeps two profile windows separate and retains rows shared by two windows", async () => {
    checker.report(1, ["profile-a/main", "shared"]);
    checker.report(2, ["profile-b/main", "shared"]);
    checker.releaseWebContents(1);
    await settle();
    expect(check.mock.calls.map(([id]) => id)).toEqual(["shared", "profile-b/main"]);
    checker.releaseWebContents(2);
    await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_INTERVAL_MS);
    checker.focus(); checker.tick();
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not cancel a queued selection when its row leaves view", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    check.mockImplementation(async () => { await gate; return ok({ status: "checked" }); });
    const handles = ["a", "b", "selected"].map((id) => checker.request(id, "selected"));
    checker.report(1, ["selected"]);
    checker.report(1, []);
    release();
    await Promise.all(handles.map((handle) => handle.result));
    expect(check.mock.calls.map(([id]) => id)).toEqual(["a", "b", "selected"]);
  });

  it("does not reuse the previous branch's pending check after checkout", async () => {
    checker.stop();
    let branch = "main";
    checker = new RemoteTipChecker({ check: checkBatch, isFocused: () => focused, keyFor: (id) => `${id}/${branch}` });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    check.mockImplementation(async () => { await gate; return ok({ status: "checked" }); });
    const first = checker.request("a", "selected");
    await vi.advanceTimersByTimeAsync(0);
    branch = "topic";
    const second = checker.request("a", "selected");
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first.result, second.result]);
  });

  it("settles cancelled handles and drops queued work on shutdown", async () => {
    const handle = checker.request("a", "visible");
    checker.stop();
    expect(await handle.result).toEqual(ok({ status: "superseded" }));
    await settle();
    expect(check).not.toHaveBeenCalled();
  });

  it("batches distinct visible branches of one repository without rechecking that repo within a minute", async () => {
    checker.stop();
    const batch = vi.fn(async (ids: string[]) => new Map(ids.map((id) =>
      [id, ok({ status: id === "topic" ? "untracked" as const : "checked" as const })]
    )));
    const deps = {
      check: batch, isFocused: () => focused,
      repositoryFor: (id: string) => id === "other" ? "repo-b" : "repo-a"
    };
    checker = new RemoteTipChecker(deps);
    checker.report(1, ["main", "topic", "other"]);
    await settle();
    expect(batch.mock.calls.map(([ids]) => ids)).toEqual([["main", "topic"], ["other"]]);
    checker.report(2, ["new-branch"]);
    checker.focus();
    await settle();
    expect(batch).toHaveBeenCalledTimes(2);
    const topic = checker.request("topic", "periodic");
    await settle();
    expect(await topic.result).toEqual(ok({ status: "untracked" }));
    const unseen = checker.request("new-branch", "periodic");
    await settle();
    expect(await unseen.result).toEqual(ok({ status: "unavailable" }));
    expect(await checker.request("new-branch", "hover").result).toEqual(ok({ status: "checked" }));
    expect(batch).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 5; i += 1) {
      checker.report(1, []);
      checker.report(1, ["main", "topic", "other"]);
      checker.focus();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(batch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(REMOTE_VISIBLE_INTERVAL_MS);
    checker.tick();
    await settle();
    expect(batch.mock.calls.slice(3).map(([ids]) => ids)).toEqual([["main", "topic", "new-branch"], ["other"]]);
  });

  it("caps repository batches at four, drops canceled/stale queued members, and lets hover promote one member", async () => {
    checker.stop();
    let branch = "old";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batch = vi.fn(async (ids: string[]) => {
      if (ids[0]?.startsWith("busy")) await gate;
      return new Map(ids.map((id) => [id, ok({ status: "checked" as const })]));
    });
    checker = new RemoteTipChecker({
      check: batch, isFocused: () => focused,
      repositoryFor: (id) => id.startsWith("busy") ? id : "queued-repo",
      keyFor: (id) => id === "stale" ? `${id}/${branch}` : id
    });
    checker.report(1, ["busy1", "busy2", "busy3", "busy4", "hovered", "stale", "cancel-me", "survivor"]);
    await settle();
    expect(batch).toHaveBeenCalledTimes(4);
    const stale = checker.request("stale", "visible");
    const canceled = checker.request("cancel-me", "visible");
    canceled.cancel();
    branch = "new";
    expect(await checker.request("hovered", "hover").result).toEqual(ok({ status: "checked" }));
    expect(batch.mock.calls.at(-1)?.[0]).toEqual(["hovered"]);
    const survivor = checker.request("survivor", "visible");
    release();
    await settle();
    expect(await stale.result).toEqual(ok({ status: "superseded" }));
    expect(await canceled.result).toEqual(ok({ status: "superseded" }));
    // This repo has not had an automatic batch yet. Hover cannot satisfy a
    // different branch or postpone that branch's first automatic check.
    expect(await survivor.result).toEqual(ok({ status: "checked" }));
    expect(batch.mock.calls.at(-1)?.[0]).toEqual(["survivor"]);
    expect(batch).toHaveBeenCalledTimes(6);
  });

  it("rechecks focus and members at dequeue without spending freshness on a skipped repository", async () => {
    checker.stop();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batch = vi.fn(async (ids: string[]) => {
      if (ids[0]?.startsWith("busy")) await gate;
      return new Map(ids.map((id) => [id, ok({ status: "checked" as const })]));
    });
    checker = new RemoteTipChecker({ check: batch, isFocused: () => focused,
      repositoryFor: (id) => id.startsWith("busy") ? id : "queued-repo" });
    checker.report(1, ["busy1", "busy2", "busy3", "busy4", "main", "topic"]);
    await settle();
    const main = checker.request("main", "visible");
    const topic = checker.request("topic", "visible");
    focused = false;
    release();
    await settle();
    expect(await Promise.all([main.result, topic.result])).toEqual([
      ok({ status: "superseded" }), ok({ status: "superseded" })
    ]);
    expect(batch).toHaveBeenCalledTimes(4);
    focused = true;
    checker.focus();
    await settle();
    expect(batch.mock.calls.at(-1)?.[0]).toEqual(["main", "topic"]);
  });

  it("serializes batches of one repository and keeps its budget after a branch switches in flight", async () => {
    checker.stop();
    let branch = "main";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batch = vi.fn(async (ids: string[]) => {
      await gate;
      return new Map(ids.map((id) => [id, ok({ status: "checked" as const })]));
    });
    checker = new RemoteTipChecker({ check: batch, isFocused: () => focused,
      repositoryFor: () => "repo", keyFor: (id) => `${id}/${branch}` });
    const first = checker.request("main", "visible");
    await settle();
    const queued = checker.request("topic", "periodic");
    await settle();
    expect(batch).toHaveBeenCalledTimes(1);
    branch = "changed";
    release();
    await settle();
    expect(await first.result).toEqual(ok({ status: "superseded" }));
    expect(await queued.result).toEqual(ok({ status: "superseded" }));
    const changed = checker.request("main", "periodic");
    await settle();
    expect(await changed.result).toEqual(ok({ status: "unavailable" }));
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await checker.request("main", "hover").result).toEqual(ok({ status: "checked" }));
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("invalidates running and queued repository answers when an explicit Git operation intervenes", async () => {
    checker.stop();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batch = vi.fn(async (ids: string[]) => {
      await gate;
      return new Map(ids.map((id) => [id, ok({ status: "checked" as const })]));
    });
    checker = new RemoteTipChecker({ check: batch, isFocused: () => focused, repositoryFor: () => "repo" });
    const running = checker.request("main", "selected");
    await vi.advanceTimersByTimeAsync(0);
    const queued = checker.request("topic", "periodic");
    checker.invalidateRepository("repo");
    release();
    await settle();
    expect(await running.result).toEqual(ok({ status: "superseded" }));
    expect(await queued.result).toEqual(ok({ status: "superseded" }));
    const retry = checker.request("topic", "periodic");
    await settle();
    expect(await retry.result).toEqual(ok({ status: "checked" }));
    expect(batch).toHaveBeenCalledTimes(2);
  });
});
