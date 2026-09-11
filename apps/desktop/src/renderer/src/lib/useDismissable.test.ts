// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDismissable } from "./useDismissable";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Popup({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  useDismissable({ open, onDismiss, triggerRef, surfaceRef });
  return createElement(
    "div",
    null,
    createElement("button", { key: "t", ref: triggerRef }, "Trigger"),
    open
      ? createElement(
          "div",
          { key: "s", ref: surfaceRef },
          createElement("button", { key: "i" }, "Inside")
        )
      : null
  );
}

function render(props: { open: boolean; onDismiss?: () => void }): void {
  act(() => {
    root.render(createElement(Popup, { onDismiss: () => {}, ...props }));
  });
}

function escape(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  });
}

const byText = (text: string): HTMLElement =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useDismissable", () => {
  it("dismisses on Escape", () => {
    const onDismiss = vi.fn();
    render({ open: true, onDismiss });
    escape();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("ignores Escape while closed", () => {
    const onDismiss = vi.fn();
    render({ open: false, onDismiss });
    escape();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger when focus was inside the surface", () => {
    render({ open: true });
    byText("Inside").focus();
    escape();
    expect(document.activeElement).toBe(byText("Trigger"));
  });

  it("returns focus when it is already on the trigger", () => {
    render({ open: true });
    byText("Trigger").focus();
    escape();
    expect(document.activeElement).toBe(byText("Trigger"));
  });

  it("leaves the key alone when an unregistered overlay holds focus", () => {
    // Not everything that floats uses this hook — the repo switcher does not.
    // Claiming Escape here would close the dialog underneath while the user
    // was dismissing the thing on top of it.
    const onDismiss = vi.fn();
    render({ open: true, onDismiss });
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();

    escape();

    expect(onDismiss).not.toHaveBeenCalled();
    other.remove();
  });

  it("still answers when focus is nowhere in particular", () => {
    // A surface that closed and dropped focus to <body> must not strand the
    // overlay behind it with no keyboard way out.
    const onDismiss = vi.fn();
    render({ open: true, onDismiss });
    (document.activeElement as HTMLElement | null)?.blur();

    escape();

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not steal focus from somewhere else on the page", () => {
    // An overlay can be dismissed while the user is typing elsewhere; yanking
    // the caret out of their field would be worse than the bug this fixes.
    render({ open: true });
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();

    escape();

    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("dismisses only the innermost overlay, whatever the mount order", () => {
    // A menu opened inside an already-open dialog is the case listener order
    // gets wrong: the dialog registered first, so stopImmediatePropagation
    // from the menu would never reach it. One Escape must close the menu and
    // leave the dialog open.
    const outer = vi.fn();
    const inner = vi.fn();

    function Nested() {
      const tRef = useRef<HTMLButtonElement>(null);
      const sRef = useRef<HTMLDivElement>(null);
      useDismissable({ open: true, onDismiss: outer, triggerRef: tRef, surfaceRef: sRef });
      return createElement(
        "div",
        { ref: sRef },
        createElement("button", { key: "t", ref: tRef }, "Outer trigger"),
        createElement(Popup, { key: "p", open: true, onDismiss: inner })
      );
    }

    act(() => root.render(createElement(Nested)));
    // Both mounted in one commit, so React registered the INNER one first —
    // open order alone would pick the outer. Focus is what decides.
    byText("Inside").focus();

    escape();
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it("hands Escape back to the outer overlay once the inner one closes", () => {
    const outer = vi.fn();

    function Nested({ innerOpen }: { innerOpen: boolean }) {
      const tRef = useRef<HTMLButtonElement>(null);
      const sRef = useRef<HTMLDivElement>(null);
      useDismissable({ open: true, onDismiss: outer, triggerRef: tRef, surfaceRef: sRef });
      return createElement(
        "div",
        { ref: sRef },
        createElement("button", { key: "t", ref: tRef }, "Outer trigger"),
        createElement(Popup, { key: "p", open: innerOpen, onDismiss: () => {} })
      );
    }

    act(() => root.render(createElement(Nested, { innerOpen: true })));
    act(() => root.render(createElement(Nested, { innerOpen: false })));

    escape();
    expect(outer).toHaveBeenCalledOnce();
  });
});
