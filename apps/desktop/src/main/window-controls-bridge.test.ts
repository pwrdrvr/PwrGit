import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  fromWebContents: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
        electronMock.handlers.set(channel, handler);
      }
    )
  }
}));

const {
  applyWindowControl,
  trackWindowFrameState,
  wireWindowControlsBridge
} = await import("./window-controls-bridge");
wireWindowControlsBridge();

function fakeWindow(overrides: { maximized?: boolean; destroyed?: boolean } = {}) {
  let maximized = overrides.maximized ?? false;
  return {
    isDestroyed: vi.fn(() => overrides.destroyed ?? false),
    isMaximized: vi.fn(() => maximized),
    minimize: vi.fn(),
    maximize: vi.fn(() => {
      maximized = true;
    }),
    unmaximize: vi.fn(() => {
      maximized = false;
    }),
    close: vi.fn()
  };
}

beforeEach(() => {
  electronMock.fromWebContents.mockReset();
});

describe("window control actions", () => {
  it("minimizes the window it was handed", () => {
    const window = fakeWindow();
    applyWindowControl(window, "minimize");
    expect(window.minimize).toHaveBeenCalledOnce();
  });

  it("toggles both ways from the window's own state", () => {
    const window = fakeWindow();
    applyWindowControl(window, "toggle-maximize");
    expect(window.maximize).toHaveBeenCalledOnce();
    applyWindowControl(window, "toggle-maximize");
    expect(window.unmaximize).toHaveBeenCalledOnce();
  });

  it("closes", () => {
    const window = fakeWindow();
    applyWindowControl(window, "close");
    expect(window.close).toHaveBeenCalledOnce();
  });

  it("ignores an action name it does not know rather than falling through", () => {
    const window = fakeWindow();
    applyWindowControl(window, "quit");
    applyWindowControl(window, { action: "close" });
    expect(window.close).not.toHaveBeenCalled();
    expect(window.minimize).not.toHaveBeenCalled();
  });

  it("touches nothing on a destroyed window", () => {
    const window = fakeWindow({ destroyed: true });
    applyWindowControl(window, "minimize");
    expect(window.minimize).not.toHaveBeenCalled();
  });
});

describe("window frame state", () => {
  it("pushes the window's own maximize changes to its renderer", () => {
    const listeners = new Map<string, () => void>();
    const send = vi.fn();
    let maximized = false;
    const window = {
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return window;
      }),
      isDestroyed: () => false,
      isMaximized: () => maximized,
      webContents: { send }
    };

    trackWindowFrameState(window as never);

    maximized = true;
    listeners.get("maximize")?.();
    maximized = false;
    listeners.get("unmaximize")?.();

    expect(send.mock.calls).toEqual([
      ["pwrgit:window-control:state", { maximized: true }],
      ["pwrgit:window-control:state", { maximized: false }]
    ]);
  });

  it("answers the renderer's opening question about the window it asked from", () => {
    const window = fakeWindow({ maximized: true });
    electronMock.fromWebContents.mockReturnValue(window);
    const handler = electronMock.handlers.get("pwrgit:window-control:state");
    expect(handler?.({ sender: {} })).toEqual({ maximized: true });
  });

  it("ignores a request from a renderer with no window", () => {
    electronMock.fromWebContents.mockReturnValue(null);
    const control = electronMock.handlers.get("pwrgit:window-control:invoke");
    expect(control?.({ sender: {} }, "close")).toBeUndefined();
    const read = electronMock.handlers.get("pwrgit:window-control:state");
    expect(read?.({ sender: {} })).toBeNull();
  });
});
