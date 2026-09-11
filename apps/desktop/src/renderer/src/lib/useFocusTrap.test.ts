// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;

function Dialog({ open, hideMiddle = false }: { open: boolean; hideMiddle?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open, containerRef: ref });
  if (!open) return null;
  return createElement(
    "div",
    { ref, role: "dialog", tabIndex: -1 },
    createElement("button", { key: "a" }, "First"),
    createElement(
      "button",
      { key: "b", ...(hideMiddle ? { style: { display: "none" } } : {}) },
      "Middle"
    ),
    createElement("button", { key: "c" }, "Last")
  );
}

function render(props: { open: boolean; hideMiddle?: boolean }): void {
  act(() => {
    root.render(createElement(Dialog, props));
  });
}

function tab(shiftKey = false): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })
    );
  });
}

const focusedLabel = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.textContent ?? undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  opener = document.createElement("button");
  opener.textContent = "Opener";
  document.body.appendChild(opener);
  opener.focus();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  opener.remove();
});

describe("useFocusTrap", () => {
  it("moves focus into the dialog on open", () => {
    render({ open: true });
    expect(focusedLabel()).toBe("First");
  });

  it("cycles forward from the last element to the first", () => {
    render({ open: true });
    (document.querySelectorAll("button")[2] as HTMLElement).focus(); // "Last"
    tab();
    expect(focusedLabel()).toBe("First");
  });

  it("cycles backward from the first element to the last", () => {
    render({ open: true });
    tab(true);
    expect(focusedLabel()).toBe("Last");
  });

  it("lets Tab move normally in the middle of the dialog", () => {
    render({ open: true });
    tab();
    // Not at an edge, so the trap does not intervene and the browser's own
    // sequential navigation (which jsdom does not run) would take over.
    expect(focusedLabel()).toBe("First");
  });

  it("pulls focus back when it has escaped the dialog", () => {
    render({ open: true });
    opener.focus();
    tab();
    expect(focusedLabel()).toBe("First");
  });

  it("skips a hidden control when cycling", () => {
    render({ open: true, hideMiddle: true });
    tab(true);
    expect(focusedLabel()).toBe("Last");
  });

  it("returns focus to whatever opened it", () => {
    render({ open: true });
    expect(focusedLabel()).toBe("First");
    render({ open: false });
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus alone when the caller moved it out deliberately", () => {
    render({ open: true });
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    render({ open: false });

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("does not resurrect an opener that has been unmounted", () => {
    render({ open: true });
    opener.remove();
    expect(() => render({ open: false })).not.toThrow();
  });
});
