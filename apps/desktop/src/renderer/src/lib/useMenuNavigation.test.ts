// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMenuNavigation } from "./useMenuNavigation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** A `role="menu"` with three items; `checked` marks one aria-checked. */
function Menu({
  open,
  onClose,
  checked
}: {
  open: boolean;
  onClose: () => void;
  checked?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuNavigation({ open, menuRef, onClose });
  if (!open) return null;
  return createElement(
    "div",
    { ref: menuRef, role: "menu" },
    ...["Alpha", "Beta", "Gamma"].map((label) =>
      createElement(
        "button",
        {
          key: label,
          role: "menuitem",
          ...(checked === undefined
            ? {}
            : { "aria-checked": String(checked === label) })
        },
        label
      )
    )
  );
}

function render(props: { open: boolean; onClose?: () => void; checked?: string }): void {
  act(() => {
    root.render(createElement(Menu, { onClose: () => {}, ...props }));
  });
}

function labels(): string[] {
  return [...container.querySelectorAll('[role="menuitem"]')].map(
    (el) => el.textContent ?? ""
  );
}

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init })
    );
  });
}

const focusedLabel = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.textContent ?? undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useMenuNavigation", () => {
  it("moves focus into the menu on open so the arrows have a start", () => {
    render({ open: true });
    expect(focusedLabel()).toBe("Alpha");
  });

  it("opens on the checked item rather than the top of the list", () => {
    render({ open: true, checked: "Beta" });
    expect(focusedLabel()).toBe("Beta");
  });

  it("keeps the menu a single tab stop via roving tabindex", () => {
    render({ open: true });
    const tabIndexes = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map((el) => el.tabIndex);
    expect(tabIndexes).toEqual([0, -1, -1]);

    press("ArrowDown");
    const after = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map((el) => el.tabIndex);
    expect(after).toEqual([-1, 0, -1]);
  });

  it("wraps in both directions", () => {
    render({ open: true });
    press("ArrowDown");
    expect(focusedLabel()).toBe("Beta");
    press("ArrowDown");
    expect(focusedLabel()).toBe("Gamma");
    press("ArrowDown");
    expect(focusedLabel()).toBe("Alpha");
    press("ArrowUp");
    expect(focusedLabel()).toBe("Gamma");
  });

  it("jumps to the ends with Home and End", () => {
    render({ open: true });
    press("End");
    expect(focusedLabel()).toBe("Gamma");
    press("Home");
    expect(focusedLabel()).toBe("Alpha");
  });

  it("typeahead jumps to a matching item", () => {
    render({ open: true });
    press("g");
    expect(focusedLabel()).toBe("Gamma");
  });

  it("typeahead accumulates within the idle window, then resets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    render({ open: true });

    // "be" must reach Beta and not stop at the first b-word.
    press("b");
    vi.setSystemTime(100);
    press("e");
    expect(focusedLabel()).toBe("Beta");

    // After the idle window a lone "g" starts a fresh search.
    vi.setSystemTime(5_000);
    press("g");
    expect(focusedLabel()).toBe("Gamma");
  });

  it("leaves modified keys and named keys to the browser", () => {
    render({ open: true });
    press("g", { metaKey: true });
    expect(focusedLabel()).toBe("Alpha");
    press("Enter");
    expect(focusedLabel()).toBe("Alpha");
  });

  it("closes on Tab so focus can leave the menu", () => {
    const onClose = vi.fn();
    render({ open: true, onClose });
    press("Tab");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores arrows once focus has left the menu", () => {
    render({ open: true });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    press("ArrowDown");

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("skips disabled items when walking", () => {
    render({ open: true });
    const [, beta] = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    beta!.setAttribute("aria-disabled", "true");

    press("ArrowDown");

    expect(labels()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(focusedLabel()).toBe("Gamma");
  });
});
