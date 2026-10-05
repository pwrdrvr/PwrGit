// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type MenuItem } from "./ContextMenu";

let container: HTMLDivElement;
let root: Root;

const items: MenuItem[] = [
  { type: "item", label: "Fork sparkline…", onSelect: () => undefined }
];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  // jsdom lays nothing out; give the menu a size so placement has one to use.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120,
    toJSON: () => ({})
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function menuLeft(): string {
  const menu = document.querySelector<HTMLElement>(".pop-menu");
  return menu?.style.left ?? "";
}

describe("ContextMenu placement", () => {
  it("opens rightward from a pointer by default", () => {
    act(() => root.render(<ContextMenu x={300} y={40} items={items} onClose={() => undefined} />));
    expect(menuLeft()).toBe("300px");
  });

  it("ends at x for a trigger on the right of its row", () => {
    act(() =>
      root.render(
        <ContextMenu x={300} y={40} align="end" items={items} onClose={() => undefined} />
      )
    );
    expect(menuLeft()).toBe("100px");
  });

  it("still keeps an end-aligned menu inside the window's left gutter", () => {
    act(() =>
      root.render(
        <ContextMenu x={120} y={40} align="end" items={items} onClose={() => undefined} />
      )
    );
    expect(menuLeft()).toBe("8px");
  });
});

describe("ContextMenu toggles", () => {
  function entries(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>(".pop-menu__item")];
  }

  it("says a toggle's state as aria-checked, not as a check typed into its label", () => {
    act(() =>
      root.render(
        <ContextMenu
          x={10}
          y={10}
          items={[
            { type: "item", label: "Group by folder", checked: true, onSelect: () => undefined },
            { type: "item", label: "Show hidden", checked: false, onSelect: () => undefined },
            { type: "item", label: "Fork sparkline…", onSelect: () => undefined }
          ]}
          onClose={() => undefined}
        />
      )
    );
    const [on, off, plain] = entries();
    expect(on?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(on?.getAttribute("aria-checked")).toBe("true");
    expect(on?.textContent).toBe("Group by folder");
    expect(on?.querySelector(".pop-menu__check svg[aria-hidden='true']")).not.toBeNull();
    // Off keeps an empty slot, so the two labels start in one column.
    expect(off?.getAttribute("aria-checked")).toBe("false");
    expect(off?.querySelector(".pop-menu__check")).not.toBeNull();
    expect(off?.querySelector(".pop-menu__check svg")).toBeNull();
    // An entry that is not a toggle draws no slot and stays a plain menuitem.
    expect(plain?.getAttribute("role")).toBe("menuitem");
    expect(plain?.hasAttribute("aria-checked")).toBe(false);
    expect(plain?.querySelector(".pop-menu__check")).toBeNull();
  });
});
