// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefRowActions, RefRowMenu } from "./RefRowMenu";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function kebab(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".refs-row-menu");
  if (el === null) throw new Error("no kebab");
  return el;
}

describe("RefRowMenu", () => {
  it("opens a menu named for the row and runs the chosen item", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <RefRowMenu
          label="Actions for main"
          items={[{ type: "item", label: "Copy branch name", onSelect }]}
        />
      )
    );
    expect(kebab().getAttribute("aria-label")).toBe("Actions for main");
    expect(kebab().getAttribute("aria-expanded")).toBe("false");
    act(() => kebab().click());
    expect(kebab().getAttribute("aria-expanded")).toBe("true");
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("Actions for main");
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.click()
    );
    expect(onSelect).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("states why a disabled entry is disabled, inside the entry", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <RefRowMenu
          label="Actions for main"
          items={[
            {
              type: "item",
              label: "Delete…",
              disabled: true,
              hint: "Switch every worktree away from this branch first",
              onSelect
            }
          ]}
        />
      )
    );
    act(() => kebab().click());
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(item?.disabled).toBe(true);
    expect(item?.textContent).toContain("Delete…");
    expect(item?.textContent).toContain("Switch every worktree away");
  });

  it("closes on a second click on the kebab", () => {
    act(() =>
      root.render(<RefRowMenu label="Actions" items={[{ type: "sep" }]} />)
    );
    act(() => kebab().click());
    act(() => kebab().click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("RefRowActions", () => {
  it("keeps an empty slot in the row so the others do not move", () => {
    act(() =>
      root.render(<RefRowActions primary={<button>Show worktree</button>} menu={<i />} />)
    );
    const slots = [...container.querySelectorAll(".refs-row-slot")].map(
      (el) => el.className
    );
    expect(slots).toEqual([
      "refs-row-slot refs-row-slot--primary",
      "refs-row-slot refs-row-slot--secondary",
      "refs-row-slot refs-row-slot--menu"
    ]);
  });
});
