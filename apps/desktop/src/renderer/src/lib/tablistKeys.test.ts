import { describe, expect, it, vi } from "vitest";
import { nextTabForKey, tablistKeyHandler } from "./tablistKeys";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const TABS = ["one", "two", "three"] as const;
type Tab = (typeof TABS)[number];

function keyEvent(key: string): ReactKeyboardEvent<HTMLElement> & {
  preventDefault: () => void;
} {
  return { key, preventDefault: vi.fn() } as unknown as ReactKeyboardEvent<HTMLElement> & {
    preventDefault: () => void;
  };
}

describe("nextTabForKey", () => {
  it("walks right and wraps at the end", () => {
    expect(nextTabForKey("ArrowRight", TABS, "one")).toBe("two");
    expect(nextTabForKey("ArrowRight", TABS, "three")).toBe("one");
  });

  it("walks left and wraps at the start", () => {
    expect(nextTabForKey("ArrowLeft", TABS, "two")).toBe("one");
    expect(nextTabForKey("ArrowLeft", TABS, "one")).toBe("three");
  });

  it("jumps to the ends", () => {
    expect(nextTabForKey("Home", TABS, "two")).toBe("one");
    expect(nextTabForKey("End", TABS, "two")).toBe("three");
  });

  it("declines keys that are not its own", () => {
    // Up/Down belong to a vertical widget; Enter and Tab belong to the browser.
    for (const key of ["ArrowUp", "ArrowDown", "Enter", "Tab", " ", "a"]) {
      expect(nextTabForKey(key, TABS, "two")).toBeUndefined();
    }
  });

  it("declines when the current tab is not in the order", () => {
    expect(nextTabForKey("ArrowRight", TABS, "missing" as Tab)).toBeUndefined();
  });

  it("declines on an empty strip rather than indexing off the end", () => {
    expect(nextTabForKey("Home", [] as readonly Tab[], "one")).toBeUndefined();
  });
});

describe("tablistKeyHandler", () => {
  it("selects the next tab and claims the key", () => {
    const select = vi.fn();
    const event = keyEvent("ArrowRight");
    tablistKeyHandler(TABS, "one", select)(event);
    expect(select).toHaveBeenCalledWith("two");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves a key it does not own entirely alone", () => {
    // Claiming Tab here would trap focus in the strip; claiming Enter would
    // swallow activation.
    const select = vi.fn();
    const event = keyEvent("Tab");
    tablistKeyHandler(TABS, "one", select)(event);
    expect(select).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
