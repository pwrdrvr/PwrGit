// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowFrameState } from "@pwrgit/shared";
import {
  __resetWindowFrameForTests,
  isWindowMaximized,
  startWindowFrameSync,
  subscribeWindowFrame
} from "./window-frame";

const readWindowFrameState = vi.fn();
const onWindowFrameState = vi.fn();
let pushFrameState: ((state: WindowFrameState) => void) | undefined;

beforeEach(() => {
  __resetWindowFrameForTests();
  readWindowFrameState.mockResolvedValue({ maximized: false });
  onWindowFrameState.mockImplementation(
    (handler: (state: WindowFrameState) => void) => {
      pushFrameState = handler;
      return vi.fn();
    }
  );
  Object.defineProperty(window, "pwrgit", {
    configurable: true,
    value: { platform: "linux", readWindowFrameState, onWindowFrameState }
  });
});

afterEach(() => {
  readWindowFrameState.mockReset();
  onWindowFrameState.mockReset();
  pushFrameState = undefined;
  __resetWindowFrameForTests();
  Reflect.deleteProperty(window, "pwrgit");
});

const stamp = (): string | undefined =>
  document.documentElement.dataset["windowFrame"];

describe("window frame sync", () => {
  it("stamps the state on <html>, where the window hairline reads it", async () => {
    startWindowFrameSync("linux");
    expect(stamp()).toBe("restored");

    pushFrameState?.({ maximized: true });
    expect(stamp()).toBe("maximized");
    expect(isWindowMaximized()).toBe(true);

    pushFrameState?.({ maximized: false });
    expect(stamp()).toBe("restored");
  });

  it("opens from the state the window already had", async () => {
    readWindowFrameState.mockResolvedValue({ maximized: true });
    startWindowFrameSync("linux");
    await Promise.resolve();
    await Promise.resolve();
    expect(stamp()).toBe("maximized");
  });

  it("tells every subscriber once per change", () => {
    startWindowFrameSync("linux");
    const listener = vi.fn();
    const stop = subscribeWindowFrame(listener);

    pushFrameState?.({ maximized: true });
    pushFrameState?.({ maximized: true });
    expect(listener).toHaveBeenCalledOnce();

    stop();
    pushFrameState?.({ maximized: false });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("subscribes once however many windows ask", () => {
    startWindowFrameSync("linux");
    startWindowFrameSync("linux");
    expect(onWindowFrameState).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32"])(
    "stays out of %s, where nothing paints a window edge",
    (platform) => {
      startWindowFrameSync(platform);
      expect(onWindowFrameState).not.toHaveBeenCalled();
      expect(readWindowFrameState).not.toHaveBeenCalled();
      expect(stamp()).toBeUndefined();
    }
  );
});
