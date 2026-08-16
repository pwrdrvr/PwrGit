// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppMenuBar } from "./AppMenuBar";

let container: HTMLDivElement;
let root: Root;
const popupAppMenu = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(window, "pwrgit", {
    configurable: true,
    value: {
      profileId: null,
      platform: "win32",
      dispatch: vi.fn(),
      on: vi.fn(),
      getAppMenuModel: vi.fn().mockResolvedValue([
        { index: 0, label: "File" },
        { index: 1, label: "Edit" },
        { index: 4, label: "Help" }
      ]),
      popupAppMenu
    }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  popupAppMenu.mockReset();
  Reflect.deleteProperty(window, "pwrgit");
});

async function renderMenu(): Promise<void> {
  await act(async () => {
    root.render(<AppMenuBar />);
  });
}

describe("AppMenuBar", () => {
  it("renders accessible top-level buttons from the native menu model", async () => {
    await renderMenu();

    expect(container.querySelector("nav")?.getAttribute("role")).toBe("menubar");
    expect(
      [...container.querySelectorAll("button")].map((button) => button.textContent)
    ).toEqual(["File", "Edit", "Help"]);
  });

  it("opens a clicked menu at the button's bottom-left", async () => {
    await renderMenu();
    const file = container.querySelector("button");
    expect(file).not.toBeNull();
    file!.getBoundingClientRect = () =>
      ({ left: 18.4, bottom: 31.6 } as DOMRect);

    await act(async () => file!.click());

    expect(popupAppMenu).toHaveBeenCalledWith({ index: 0, x: 18, y: 32 });
  });

  it("supports Windows Alt mnemonics", async () => {
    await renderMenu();
    const edit = container.querySelectorAll("button")[1]!;
    edit.getBoundingClientRect = () =>
      ({ left: 57, bottom: 32 } as DOMRect);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", altKey: true })
      );
    });

    expect(popupAppMenu).toHaveBeenCalledWith({ index: 1, x: 57, y: 32 });
  });
});
