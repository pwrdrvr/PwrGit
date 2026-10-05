import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createEventFanout } from "./event-fanout";

const IPC = "pwrgit:event";

function setup() {
  const ipc = new EventEmitter();
  const reportError = vi.fn();
  const subscribe = createEventFanout(ipc, IPC, reportError);
  const send = (channel: string, payload: unknown) => ipc.emit(IPC, {}, channel, payload);
  return { ipc, subscribe, send, reportError };
}

describe("event fan-out", () => {
  it("holds one IPC listener however many subscriptions there are", async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      const { ipc, subscribe } = setup();
      // Well past EventEmitter's default limit of 10, on one channel and many.
      const offs = Array.from({ length: 60 }, (_, i) =>
        subscribe(i % 2 === 0 ? "repo:changed" : `channel:${i}`, () => {})
      );
      expect(ipc.listenerCount(IPC)).toBe(1);
      for (const off of offs) off();
      expect(ipc.listenerCount(IPC)).toBe(1);
      // process.emitWarning delivers on a later tick: listen past it.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
  });

  it("delivers each event only to its own channel's subscribers", () => {
    const { subscribe, send } = setup();
    const repo = vi.fn();
    const repoToo = vi.fn();
    const worktree = vi.fn();
    subscribe("repo:changed", repo);
    subscribe("repo:changed", repoToo);
    subscribe("worktree:changed", worktree);

    send("repo:changed", { repoId: "r1" });

    expect(repo).toHaveBeenCalledExactlyOnceWith({ repoId: "r1" });
    expect(repoToo).toHaveBeenCalledExactlyOnceWith({ repoId: "r1" });
    expect(worktree).not.toHaveBeenCalled();

    send("nobody:listens", {});
    expect(repo).toHaveBeenCalledOnce();
    expect(repoToo).toHaveBeenCalledOnce();
    expect(worktree).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe, and unsubscribing twice is harmless", () => {
    const { subscribe, send } = setup();
    const kept = vi.fn();
    const dropped = vi.fn();
    subscribe("repo:changed", kept);
    const off = subscribe("repo:changed", dropped);

    off();
    off();
    send("repo:changed", 1);

    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
  });

  it("treats the same function subscribed twice as two subscriptions", () => {
    const { subscribe, send } = setup();
    const handler = vi.fn();
    const first = subscribe("repo:changed", handler);
    subscribe("repo:changed", handler);

    send("repo:changed", 1);
    expect(handler).toHaveBeenCalledTimes(2);

    first();
    send("repo:changed", 2);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("resubscribes cleanly after a channel's last subscriber leaves", () => {
    const { subscribe, send } = setup();
    const stale = subscribe("repo:changed", () => {});
    stale();
    const handler = vi.fn();
    subscribe("repo:changed", handler);
    stale();

    send("repo:changed", 1);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not deliver the in-flight event to a subscriber added or removed by a handler", () => {
    const { subscribe, send } = setup();
    const late = vi.fn();
    const removed = vi.fn();
    let offRemoved = (): void => {};
    subscribe("repo:changed", () => {
      offRemoved();
      subscribe("repo:changed", late);
    });
    offRemoved = subscribe("repo:changed", removed);

    send("repo:changed", 1);
    expect(removed).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();

    send("repo:changed", 2);
    expect(late).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("keeps delivering past a throwing subscriber and reports the error", () => {
    const { subscribe, send, reportError } = setup();
    const boom = new Error("boom");
    const after = vi.fn();
    subscribe("repo:changed", () => {
      throw boom;
    });
    subscribe("repo:changed", after);

    send("repo:changed", 1);

    expect(after).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
  });
});
