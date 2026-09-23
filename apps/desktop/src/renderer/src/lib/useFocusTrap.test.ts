// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A second trap in its own DOM subtree — DialogHost's confirm, opened while
 *  PruneWorktreesDialog's trap is still active behind it. */
function Stacked({ upper }: { upper: boolean }) {
  const lowerRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ open: true, containerRef: lowerRef });
  useFocusTrap({ open: upper, containerRef: upperRef });
  return createElement(
    "div",
    null,
    createElement(
      "div",
      { key: "lower", ref: lowerRef, role: "dialog", tabIndex: -1 },
      createElement("button", null, "Lower first"),
      createElement("button", null, "Lower last")
    ),
    upper
      ? createElement(
          "div",
          { key: "upper", ref: upperRef, role: "alertdialog", tabIndex: -1 },
          createElement("button", null, "Upper first"),
          createElement("button", null, "Upper last")
        )
      : null
  );
}

describe("useFocusTrap, stacked", () => {
  const button = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;

  it("lets only the upper dialog answer Tab while it is open", () => {
    act(() => root.render(createElement(Stacked, { upper: false })));
    act(() => root.render(createElement(Stacked, { upper: true })));
    expect(focusedLabel()).toBe("Upper first");

    button("Upper last").focus();
    tab();
    expect(focusedLabel()).toBe("Upper first");

    tab(true);
    expect(focusedLabel()).toBe("Upper last");
  });

  it("leaves a mid-cycle Tab in the upper dialog to the browser", () => {
    act(() => root.render(createElement(Stacked, { upper: false })));
    act(() => root.render(createElement(Stacked, { upper: true })));
    expect(focusedLabel()).toBe("Upper first");

    // Not at an edge, so no trap may intervene: the browser's own sequential
    // navigation moves to "Upper last". The lower trap used to see focus
    // outside ITS dialog and pull it back behind the upper one — and the
    // upper trap then dragged it to its own first stop, so Tab never left it.
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe("Upper first");
  });

  it("pulls stray focus into the upper dialog, not the one beneath it", () => {
    act(() => root.render(createElement(Stacked, { upper: false })));
    act(() => root.render(createElement(Stacked, { upper: true })));
    opener.focus();
    tab();
    expect(focusedLabel()).toBe("Upper first");
  });

  it("hands Tab back to the lower dialog once the upper one closes", () => {
    act(() => root.render(createElement(Stacked, { upper: false })));
    button("Lower last").focus();
    act(() => root.render(createElement(Stacked, { upper: true })));
    act(() => root.render(createElement(Stacked, { upper: false })));
    expect(focusedLabel()).toBe("Lower last");
    tab();
    expect(focusedLabel()).toBe("Lower first");
  });
});

/** DialogHost's choice dialog: a facts list above the buttons, which Chromium
 *  makes a Tab stop of its own once it overflows. */
function Scrolly({ nestButton = false }: { nestButton?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open: true, containerRef: ref });
  return createElement(
    "div",
    { ref, role: "dialog", tabIndex: -1 },
    createElement(
      "ul",
      { key: "facts", className: "facts", style: { overflowY: "auto" } },
      createElement("li", null, "src/sprocket/cache.ts"),
      nestButton ? createElement("button", null, "Copy paths") : null
    ),
    createElement("button", { key: "keep" }, "Keep"),
    createElement("button", { key: "discard" }, "Discard")
  );
}

describe("useFocusTrap, keyboard-focusable scrollers", () => {
  const button = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;
  /** jsdom does no layout; give the list the overflow Chromium would see. */
  function overflow(el: HTMLElement): void {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 118 });
  }
  const facts = (): HTMLElement => document.querySelector<HTMLElement>(".facts")!;
  function pressTab(shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  it("still lands initial focus on the first control, not the list", () => {
    act(() => root.render(createElement(Scrolly)));
    overflow(facts());
    expect(focusedLabel()).toBe("Keep");
  });

  it("leaves Shift+Tab from the first button to the browser, which reaches the list", () => {
    act(() => root.render(createElement(Scrolly)));
    overflow(facts());
    // The trap used to take "Keep" for the first stop and wrap to "Discard",
    // so the list was never reachable.
    expect(pressTab(true).defaultPrevented).toBe(false);
  });

  it("wraps Tab from the last button to the list", () => {
    act(() => root.render(createElement(Scrolly)));
    overflow(facts());
    // jsdom will not focus a div without a tabindex; Chromium does.
    const focus = vi.spyOn(facts(), "focus");
    button("Discard").focus();
    expect(pressTab().defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  it("does not count a list that does not overflow", () => {
    act(() => root.render(createElement(Scrolly)));
    button("Discard").focus();
    pressTab();
    expect(focusedLabel()).toBe("Keep");
  });

  it("does not count a list that holds a control of its own", () => {
    act(() => root.render(createElement(Scrolly, { nestButton: true })));
    overflow(facts());
    const focus = vi.spyOn(facts(), "focus");
    button("Discard").focus();
    pressTab();
    expect(focus).not.toHaveBeenCalled();
    expect(focusedLabel()).toBe("Copy paths");
  });
});
