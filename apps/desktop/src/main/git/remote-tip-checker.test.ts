import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { RemoteTipChecker, REMOTE_VISIBLE_DEBOUNCE_MS, REMOTE_VISIBLE_INTERVAL_MS, type RemoteCheckReason } from "./remote-tip-checker";

describe("RemoteTipChecker", () => {
  let checker: RemoteTipChecker;
  let focused: boolean;
  const check = vi.fn(async (_id: string, _request: { reason: RemoteCheckReason; userAction: boolean }) => ok({ status: "checked" as const }));
  beforeEach(() => {
    vi.useFakeTimers();
    check.mockReset();
    check.mockResolvedValue(ok({ status: "checked" }));
    focused = true;
    checker = new RemoteTipChecker({ check, isFocused: () => focused });
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
    checker = new RemoteTipChecker({ check, isFocused: () => focused, keyFor: (id) => `${id}/${branch}` });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    check.mockImplementation(async () => { await gate; return ok({ status: "checked" }); });
    const first = checker.request("a", "selected");
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
});
