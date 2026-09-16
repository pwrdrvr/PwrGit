import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMainWindow: vi.fn(),
  getFocusedWindow: vi.fn(() => null)
}));

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: mocks.getFocusedWindow }
}));
vi.mock("./window", () => ({ createMainWindow: mocks.createMainWindow }));

const { createProfileWindows } = await import("./profile-windows");

/** A BrowserWindow stand-in whose close is a two-step teardown, as Electron's
 *  is: `close` fires first, `closed` and destruction land later. */
function fakeWindow() {
  let destroyed = false;
  const window = Object.assign(new EventEmitter(), {
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: vi.fn(() => false),
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(() => window.emit("close")),
    /** The rest of the teardown, which Electron runs a turn or more later. */
    finishClosing: () => {
      destroyed = true;
      window.emit("closed");
    }
  });
  return window;
}

function windows() {
  return createProfileWindows({
    appearance: () => ({ resolvedTheme: "dark" }) as never
  });
}

beforeEach(() => {
  // Reset, not clear: these tests queue windows with `mockReturnValueOnce`,
  // and a queue left unconsumed by a failing test would hand the next one a
  // window it never created.
  vi.resetAllMocks();
  mocks.getFocusedWindow.mockReturnValue(null);
});

describe("profile windows", () => {
  it("focuses the existing window rather than opening a second one", () => {
    const first = fakeWindow();
    mocks.createMainWindow.mockReturnValueOnce(first);
    const profiles = windows();

    expect(profiles.open("acme").created).toBe(true);
    const again = profiles.open("acme");
    expect(again.created).toBe(false);
    expect(again.window).toBe(first);
    expect(first.focus).toHaveBeenCalledOnce();
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
  });

  it("treats a window that has begun closing as gone", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    mocks.createMainWindow.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const profiles = windows();
    profiles.open("acme");

    // Electron has fired `close` but not yet `closed`, so the window still
    // reports itself undestroyed. A reveal arriving now must not be handed to
    // it — it is a corpse that has not finished falling over.
    first.close();
    expect(first.isDestroyed()).toBe(false);
    expect(profiles.has("acme")).toBe(false);
    expect(profiles.openProfileIds()).toEqual([]);

    const reopened = profiles.open("acme");
    expect(reopened.created).toBe(true);
    expect(reopened.window).toBe(second);
    expect(first.focus).not.toHaveBeenCalled();
  });

  it("keeps the replacement when the window it replaced finishes closing", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    mocks.createMainWindow.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const profiles = windows();
    profiles.open("acme");
    first.close();
    profiles.open("acme");

    // The loser's `closed` lands after the replacement is registered; it must
    // not evict the window that took its place.
    first.finishClosing();
    expect(profiles.has("acme")).toBe(true);
    expect(profiles.open("acme").window).toBe(second);
    expect(mocks.createMainWindow).toHaveBeenCalledTimes(2);
  });

  it("reports a closing window as closed rather than closing it twice", () => {
    const first = fakeWindow();
    mocks.createMainWindow.mockReturnValueOnce(first);
    const profiles = windows();
    profiles.open("acme");

    expect(profiles.close("acme")).toBe(true);
    expect(first.close).toHaveBeenCalledOnce();
    expect(profiles.close("acme")).toBe(false);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("drops a window from the open set once it is destroyed", () => {
    const first = fakeWindow();
    mocks.createMainWindow.mockReturnValueOnce(first);
    const profiles = windows();
    profiles.open("acme");
    expect(profiles.openProfileIds()).toEqual(["acme"]);

    first.close();
    first.finishClosing();
    expect(profiles.has("acme")).toBe(false);
    expect(profiles.profileFor(first as unknown as BrowserWindow)).toBe(null);
  });
});
