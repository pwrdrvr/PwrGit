// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { hoverTooltip, useViewportTooltip } from "./useViewportTooltip";

/**
 * Escape ALWAYS dismisses a hover card — that is WCAG 2.1 SC 1.4.13, and it is
 * not negotiable. Whether the card also *claims* the keystroke is: claiming is
 * `preventDefault`, which is the signal `DiffPane` and `FileInsightsPane` read
 * to decide whether to stay open, so a card that claims holds those panes open.
 *
 * It may only do that when the card is where the user actually is. The pointer
 * parks itself wherever it was last left, and once most controls carry a card
 * it is always on one — so a pointer-opened card claiming Escape meant the diff
 * pane could not be closed from the keyboard at all. See "A hover card claims
 * Escape only if the keyboard summoned it" in this directory's AGENTS.md.
 */

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  // Awaited, not fired and forgotten: an unmount still sitting in React's act
  // queue makes the NEXT test's render fail to flush, and the symptom is a
  // null trigger in a test that has nothing to do with this one.
  await cleanup?.();
  cleanup = undefined;
});

function Harness({ interactive }: { interactive: boolean }) {
  // The interactive card takes a class of its own, as every real caller does:
  // `.viewport-tooltip` is `pointer-events: none`, so pairing it with
  // `interactive` would model a card no pointer could ever enter.
  const tip = useViewportTooltip(
    interactive ? "commit-context-card" : "viewport-tooltip",
    interactive ? { interactive: true } : {}
  );
  return (
    <>
      <button
        id="trigger"
        {...hoverTooltip(
          tip,
          interactive ? (
            <button id="inside">Cancel</button>
          ) : (
            "Fetch all remotes"
          )
        )}
      >
        Fetch
      </button>
      {tip.tooltipNode}
    </>
  );
}

const mount = async (interactive = false): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness interactive={interactive} />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container.querySelector<HTMLElement>("#trigger")!;
};

/** React turns a bubbling `mouseover` into `onMouseEnter`, the same route
 * `ForgeChip.test.tsx` takes. */
const hover = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
};

const card = (): Element | null => document.querySelector('[role="tooltip"]');

/** Returns the event so the caller can read whether anyone claimed it. */
const pressEscape = async (): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true
  });
  await act(async () => {
    window.dispatchEvent(event);
  });
  return event;
};

it("dismisses a pointer-opened card without claiming the keystroke", async () => {
  const trigger = await mount();
  await hover(trigger);
  expect(card()?.textContent).toBe("Fetch all remotes");

  const event = await pressEscape();

  expect(card()).toBeNull();
  // The whole point: the pane underneath still gets to act on this key.
  expect(event.defaultPrevented).toBe(false);
});

it("claims the keystroke for a card the user has tabbed into", async () => {
  const trigger = await mount(true);
  await hover(trigger);
  const inside = document.querySelector<HTMLElement>("#inside");
  expect(inside).not.toBeNull();
  // Focus INSIDE the card is the reachable half of "the keyboard summoned it".
  // The other half is a `:focus-visible` trigger, which jsdom cannot express —
  // it answers `false` for every element, focused or not.
  await act(async () => inside!.focus());

  const event = await pressEscape();

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(event.defaultPrevented).toBe(true);
  // Dismissing must not strand a keyboard user at the top of the document.
  expect(document.activeElement).toBe(trigger);
});

/**
 * Hover targets nest: a file row carries a card and the path inside it carries
 * another. React fires no `mouseenter` on an ancestor the pointer never left,
 * so leaving the inner one has to put the outer one's card back by hand — a
 * native `title` did that for free, and losing it leaves the pointer sitting
 * on a trigger showing nothing.
 */
function NestedHarness() {
  const tip = useViewportTooltip();
  return (
    <>
      <div id="row" {...hoverTooltip(tip, "Stage this file")}>
        <span id="path" {...hoverTooltip(tip, "src/deep/file.ts")}>
          file.ts
        </span>
      </div>
      {tip.tooltipNode}
    </>
  );
}

const move = async (to: Element, from: Element | null): Promise<void> => {
  await act(async () => {
    to.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: from })
    );
    if (from !== null) {
      from.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: to })
      );
    }
  });
};

it("restores the row's card when the pointer leaves a nested trigger", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<NestedHarness />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const row = container.querySelector<HTMLElement>("#row")!;
  const path = container.querySelector<HTMLElement>("#path")!;

  await move(row, document.body);
  expect(card()?.textContent).toBe("Stage this file");

  // Inward: the inner trigger takes the card over.
  await move(path, row);
  expect(card()?.textContent).toBe("src/deep/file.ts");

  // Back out to the row. Only the inner `mouseleave` fires here, so without
  // the restore the pointer would be on the row with no card at all.
  await move(row, path);
  expect(card()?.textContent).toBe("Stage this file");

  // Leaving the row for good still dismisses.
  await move(document.body, row);
  expect(card()).toBeNull();
});
