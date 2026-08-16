import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  appMenu: null as null | { items: unknown[] },
  modelHandler: null as null | (() => unknown),
  popupListener: null as null | ((event: unknown, payload: unknown) => void),
  fromWebContents: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: {
    handle: vi.fn((channel: string, handler: () => unknown) => {
      if (channel === "pwrgit:app-menu:model") electronMock.modelHandler = handler;
    }),
    on: vi.fn(
      (channel: string, listener: (event: unknown, payload: unknown) => void) => {
        if (channel === "pwrgit:app-menu:popup") {
          electronMock.popupListener = listener;
        }
      }
    )
  },
  Menu: { getApplicationMenu: () => electronMock.appMenu }
}));

const { wireAppMenuBridge } = await import("./app-menu-bridge");
wireAppMenuBridge();

const submenu = (): { popup: ReturnType<typeof vi.fn> } => ({ popup: vi.fn() });

beforeEach(() => {
  electronMock.appMenu = null;
  electronMock.fromWebContents.mockReset();
});

describe("Windows app menu model", () => {
  it("returns visible top-level submenus with their original indices", () => {
    electronMock.appMenu = {
      items: [
        { role: "appMenu", label: "PwrGit", submenu: submenu() },
        { label: "File", submenu: submenu() },
        { label: "Edit", submenu: submenu() },
        { label: "Hidden", visible: false, submenu: submenu() },
        { label: "Detached" },
        { label: "Help", submenu: submenu() }
      ]
    };

    expect(electronMock.modelHandler?.()).toEqual([
      { index: 1, label: "File" },
      { index: 2, label: "Edit" },
      { index: 5, label: "Help" }
    ]);
  });

  it("returns an empty model before an application menu exists", () => {
    expect(electronMock.modelHandler?.()).toEqual([]);
  });
});

describe("Windows app menu popup", () => {
  it("opens the indexed native submenu at rounded window coordinates", () => {
    const popup = vi.fn();
    electronMock.appMenu = {
      items: [{ label: "File", submenu: { popup } }]
    };
    const window = { id: 7 };
    electronMock.fromWebContents.mockReturnValue(window);

    electronMock.popupListener?.(
      { sender: { id: 3 } },
      { index: 0, x: 10.4, y: 31.6 }
    );

    expect(electronMock.fromWebContents).toHaveBeenCalledWith({ id: 3 });
    expect(popup).toHaveBeenCalledWith({ window, x: 10, y: 32 });
  });

  it.each([null, "bad", {}, { index: "0" }])(
    "ignores malformed payload %j",
    (payload) => {
      const popup = vi.fn();
      electronMock.appMenu = {
        items: [{ label: "File", submenu: { popup } }]
      };
      electronMock.fromWebContents.mockReturnValue({ id: 7 });

      electronMock.popupListener?.({ sender: {} }, payload);

      expect(popup).not.toHaveBeenCalled();
    }
  );
});
