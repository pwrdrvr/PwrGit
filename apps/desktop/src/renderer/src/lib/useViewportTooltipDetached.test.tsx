// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import {
  hoverTooltip,
  useViewportTooltip,
  type ViewportTooltip
} from "./useViewportTooltip";

/**
 * A card is anchored to the element that opened it, and an element can leave
 * the document without the pointer ever leaving it: a graph row unmounts when
 * its commit drops out of a refreshed list, and React dispatches no
 * `mouseleave` for a node it removes. Two failures followed.
 *
 * - A gated open (`hoverIntent` polls, then calls `show(target)`) can fire
 *   after the row it captured is gone. A detached element's rect is all zeros,
 *   so the card was placed at the viewport origin — over the traffic lights
 *   and the sidebar header, next to nothing.
 * - A card already open when its trigger left had nothing left to close it: no
 *   `mouseleave`, and no scroll if the list was replaced rather than scrolled.
 */

let tip: ViewportTooltip | undefined;
let setMounted: ((mounted: boolean) => void) | undefined;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  tip = undefined;
  setMounted = undefined;
});

function Harness({ interactive }: { interactive: boolean }) {
  const t = useViewportTooltip(
    interactive ? "commit-context-card" : "viewport-tooltip",
    interactive ? { interactive: true } : {}
  );
  tip = t;
  const [present, setPresent] = useState(true);
  setMounted = setPresent;
  return (
    <>
      {present ? (
        <button id="trigger" {...hoverTooltip(t, "Fetch all remotes")}>
          Fetch
        </button>
      ) : null}
      {t.tooltipNode}
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

const hover = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
};

const anyCard = (): Element | null =>
  document.querySelector('[role="tooltip"], [role="dialog"]');

/** Unmount the trigger the way a refreshed list does: React removes the node
 * and dispatches no `mouseleave` for it. */
const unmountTrigger = async (): Promise<void> => {
  await act(async () => setMounted!(false));
};

it("does not open a card for a trigger that left the document before the show", async () => {
  await mount();
  const gone = document.createElement("div");
  // Never attached: exactly what a gated poll holds after its row unmounted.
  expect(gone.isConnected).toBe(false);

  await act(async () => {
    tip!.show(gone, "Would land at the origin", { x: 0, y: 0 });
  });

  expect(anyCard()).toBeNull();
  expect(tip!.visible).toBe(false);
});

it("closes a card when its trigger is removed from the document", async () => {
  const trigger = await mount();
  await hover(trigger);
  expect(anyCard()?.textContent).toBe("Fetch all remotes");

  await unmountTrigger();

  expect(anyCard()).toBeNull();
  expect(tip!.visible).toBe(false);
});

it("closes an interactive card when its trigger is removed, pointer or no", async () => {
  const trigger = await mount(true);
  await hover(trigger);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();

  await unmountTrigger();

  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("closes a pinned card whose trigger is gone — there is nothing left to be pinned to", async () => {
  const trigger = await mount(true);
  await hover(trigger);
  await act(async () => tip!.setSticky(true));

  await unmountTrigger();

  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("leaves a card alone while its trigger stays and the page changes around it", async () => {
  const trigger = await mount();
  await hover(trigger);

  await act(async () => {
    const other = document.createElement("div");
    document.body.append(other);
    other.remove();
  });

  expect(anyCard()?.textContent).toBe("Fetch all remotes");
});
