import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showWindowWhenReady } from "./show-window-when-ready";

function createWindow(platform: NodeJS.Platform = "linux") {
  vi.useFakeTimers();
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    show: vi.fn(),
    isDestroyed: vi.fn(() => false)
  });
  showWindowWhenReady(window as unknown as BrowserWindow, platform);
  return window;
}

afterEach(() => vi.useRealTimers());

describe("first window visibility", () => {
  it.each(["linux", "win32"] as const)(
    "shows a loaded %s window even when ready-to-show never arrives",
    (platform) => {
      const window = createWindow(platform);
      vi.advanceTimersByTime(1000);
      expect(window.show).not.toHaveBeenCalled();
      window.webContents.emit("did-finish-load");
      vi.advanceTimersByTime(500);
      expect(window.show).toHaveBeenCalledOnce();
      window.emit("ready-to-show");
      expect(window.show).toHaveBeenCalledOnce();
    }
  );

  it("cancels a pending fallback when ready-to-show arrives", () => {
    const window = createWindow();
    window.webContents.emit("did-finish-load");
    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(window.show).toHaveBeenCalledOnce();
  });

  it("does not show again after an early ready-to-show and subsequent loads", () => {
    const window = createWindow();
    window.emit("ready-to-show");
    window.webContents.emit("did-finish-load");
    window.webContents.emit("did-finish-load");
    vi.advanceTimersByTime(1000);
    expect(window.show).toHaveBeenCalledOnce();
  });

  it("cancels the fallback when closed and ignores later events", () => {
    const window = createWindow();
    window.webContents.emit("did-finish-load");
    window.emit("closed");
    expect(vi.getTimerCount()).toBe(0);
    window.emit("ready-to-show");
    vi.advanceTimersByTime(1000);
    expect(window.show).not.toHaveBeenCalled();
  });

  it("does not show a destroyed window", () => {
    const window = createWindow();
    window.webContents.emit("did-finish-load");
    window.isDestroyed.mockReturnValue(true);
    vi.advanceTimersByTime(500);
    expect(window.show).not.toHaveBeenCalled();
  });

  it("preserves ready-to-show behavior on macOS", () => {
    const window = createWindow("darwin");
    window.webContents.emit("did-finish-load");
    vi.advanceTimersByTime(1000);
    expect(window.show).not.toHaveBeenCalled();
    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledOnce();
  });
});
