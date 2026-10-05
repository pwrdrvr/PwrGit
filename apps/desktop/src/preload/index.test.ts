import { EventEmitter } from "node:events";
import { IPC_EVENT_CHANNEL } from "@pwrgit/shared";
import { expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  exposed: new Map<string, unknown>()
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const ipcRenderer = Object.assign(new Emitter(), {
    invoke: vi.fn(),
    send: vi.fn()
  });
  return {
    ipcRenderer,
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => electronMock.exposed.set(key, api)
    }
  };
});

const { ipcRenderer } = (await import("electron")) as unknown as {
  ipcRenderer: EventEmitter;
};
await import("./index");
const bridge = electronMock.exposed.get("pwrgit") as {
  on: (channel: string, handler: (payload: unknown) => void) => () => void;
};

it("serves every bridge subscription from one ipcRenderer listener", () => {
  // About what a window holds with a repo open and a dialog up.
  const handlers = Array.from({ length: 45 }, () => vi.fn());
  const offs = handlers.map((handler, i) =>
    bridge.on(i < 5 ? "worktree:changed" : `channel:${i}`, handler)
  );
  expect(ipcRenderer.listenerCount(IPC_EVENT_CHANNEL)).toBe(1);

  ipcRenderer.emit(IPC_EVENT_CHANNEL, {}, "worktree:changed", { worktreeId: "w1" });
  for (const [i, handler] of handlers.entries()) {
    if (i < 5) expect(handler).toHaveBeenCalledExactlyOnceWith({ worktreeId: "w1" });
    else expect(handler).not.toHaveBeenCalled();
  }

  for (const off of offs) off();
  ipcRenderer.emit(IPC_EVENT_CHANNEL, {}, "worktree:changed", {});
  expect(handlers[0]).toHaveBeenCalledOnce();
  expect(ipcRenderer.listenerCount(IPC_EVENT_CHANNEL)).toBe(1);
});
