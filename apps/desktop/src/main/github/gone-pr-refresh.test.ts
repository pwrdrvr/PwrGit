import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGonePrRefresh } from "./gone-pr-refresh";

describe("createGonePrRefresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends one batch per repository after a tick", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const gone = createGonePrRefresh(refresh, 250);
    gone.queue("repo-a", "feat/one", false);
    gone.queue("repo-a", "feat/two", false);
    gone.queue("repo-b", "fix/three", false);
    gone.queue("repo-a", "feat/one", false);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith(
      "repo-a",
      ["feat/one", "feat/two"],
      "scheduled"
    );
    expect(refresh).toHaveBeenCalledWith("repo-b", ["fix/three"], "scheduled");
  });

  // The transition is the moment the cached answer is most likely wrong; a
  // branch that stays gone with an open PR (a fork's head) must not re-ask at
  // the user tier on every poll.
  it("asks at the user tier when any branch in the batch just went gone", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const gone = createGonePrRefresh(refresh, 250);
    gone.queue("repo-a", "feat/old", false);
    gone.queue("repo-a", "feat/new", true);
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      "repo-a",
      ["feat/old", "feat/new"],
      "user"
    );
  });

  it("drops what is queued when stopped, and asks nothing after", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const gone = createGonePrRefresh(refresh, 250);
    gone.queue("repo-a", "feat/one", true);
    gone.stop();
    await vi.advanceTimersByTimeAsync(500);
    // A probe that lands during quit, after the handlers have stopped.
    gone.queue("repo-a", "feat/two", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("survives a failed refresh", async () => {
    const refresh = vi.fn(() => Promise.reject(new Error("offline")));
    const gone = createGonePrRefresh(refresh, 250);
    gone.queue("repo-a", "feat/one", true);
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A rejection is swallowed; the next queue still schedules.
    gone.queue("repo-a", "feat/two", false);
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
