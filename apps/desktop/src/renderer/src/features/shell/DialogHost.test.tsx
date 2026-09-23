// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { DialogHost } from "./DialogHost";
import { closeDialog, confirmDialog, currentDialog } from "./dialogs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;

function press(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  act(() => {
    (document.activeElement ?? window).dispatchEvent(event);
  });
  return event;
}

const focusedLabel = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.textContent ?? undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  opener = document.createElement("button");
  opener.textContent = "Delete branch…";
  document.body.append(opener);
  opener.focus();
  root = createRoot(container);
});

afterEach(() => {
  // The queue is module state: a test that fails with its dialog still open
  // would otherwise leave it at the front for the next test to answer.
  act(() => {
    for (let d = currentDialog(); d !== null; d = currentDialog()) closeDialog(d.id, false);
  });
  act(() => root.unmount());
  container.remove();
  opener.remove();
});

function ask(): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = confirmDialog({
      title: "Delete feature/gear-ratio?",
      message: "Its 2 commits will be unreachable.",
      confirmLabel: "Delete",
      danger: true
    });
  });
  return answer;
}

describe("DialogHost focus", () => {
  it("keeps Tab inside the dialog", () => {
    act(() => root.render(createElement(DialogHost)));
    const answer = ask();
    expect(focusedLabel()).toBe("Delete");

    press("Tab");
    expect(focusedLabel()).toBe("Cancel");
    press("Tab", true);
    expect(focusedLabel()).toBe("Delete");

    press("Escape");
    return expect(answer).resolves.toBe(false);
  });

  it("gives focus back to whatever opened the dialog", async () => {
    act(() => root.render(createElement(DialogHost)));
    const answer = ask();
    press("Escape");
    await answer;
    expect(document.activeElement).toBe(opener);
  });

  it("answers Tab itself when opened over another trapped dialog", () => {
    // PruneWorktreesDialog asks through confirmDialog while its own trap is
    // active. Its trap used to take the confirm's Tab and pull focus behind it.
    function Behind() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap({ open: true, containerRef: ref });
      return createElement(
        "div",
        { ref, role: "dialog", tabIndex: -1 },
        createElement("button", null, "Remove 2 worktrees")
      );
    }
    act(() =>
      root.render(
        createElement("div", null, createElement(Behind), createElement(DialogHost))
      )
    );
    const answer = ask();
    expect(focusedLabel()).toBe("Delete");

    press("Tab");
    expect(focusedLabel()).toBe("Cancel");

    press("Escape");
    return expect(answer).resolves.toBe(false);
  });
});
