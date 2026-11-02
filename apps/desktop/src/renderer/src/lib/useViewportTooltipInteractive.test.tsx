// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  hoverTooltip,
  pinnableTooltip,
  useViewportTooltip
} from "./useViewportTooltip";

/**
 * An interactive card has controls in it, so the pointer has to be able to
 * travel from its trigger onto them. The Changes rail's "Why?" card opened
 * 8px above its trigger and closed on the trigger's first `mouseleave`, so
 * none of its buttons could be reached, whether the trigger was clicked first
 * or not. See "Interactive cards must be reachable" in this directory's
 * AGENTS.md.
 */

let cleanup: (() => Promise<void>) | undefined;
let action: Mock<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  action = vi.fn<() => void>();
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Harness({
  interactive,
  pinnable
}: {
  interactive: boolean;
  pinnable: boolean;
}) {
  const tip = useViewportTooltip(
    interactive ? "commit-context-card" : "viewport-tooltip",
    interactive ? { interactive: true, label: "Explain" } : {}
  );
  const content = interactive ? (
    <button id="inside" onClick={() => action()}>
      Copy rule details
    </button>
  ) : (
    "Plain tooltip"
  );
  return (
    <>
      <button
        id="trigger"
        {...(pinnable ? pinnableTooltip(tip, content) : hoverTooltip(tip, content))}
      >
        Why?
      </button>
      <button id="elsewhere">Elsewhere</button>
      {tip.tooltipNode}
    </>
  );
}

const mount = async ({
  interactive = true,
  pinnable = false
}: { interactive?: boolean; pinnable?: boolean } = {}): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<Harness interactive={interactive} pinnable={pinnable} />)
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container.querySelector<HTMLElement>("#trigger")!;
};

const card = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"], [role="tooltip"]');
const elsewhere = (): HTMLElement => document.querySelector<HTMLElement>("#elsewhere")!;

const hover = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
};

/** The pointer leaves `from` for `to`. React derives both `onMouseLeave` on
 *  `from` and `onMouseEnter` on `to` from this one native event. */
const move = async (from: HTMLElement, to: HTMLElement | null): Promise<void> => {
  await act(async () => {
    from.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: to })
    );
  });
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

it("gives the pointer time to cross from the trigger to an interactive card", async () => {
  const trigger = await mount();
  await hover(trigger);
  expect(card()).not.toBeNull();

  // Crossing the gap: the pointer is over neither the trigger nor the card.
  await move(trigger, document.body);
  expect(card()).not.toBeNull();

  // It arrives, and the card stays for as long as the pointer is on it.
  await move(document.body, card()!);
  await advance(2_000);
  expect(card()).not.toBeNull();

  await act(async () => document.querySelector<HTMLElement>("#inside")!.click());
  expect(action).toHaveBeenCalledOnce();
});

it("still closes an interactive card the pointer never reaches", async () => {
  const trigger = await mount();
  await hover(trigger);
  await move(trigger, elsewhere());
  await advance(1_000);
  expect(card()).toBeNull();
});

it("keeps the card when the pointer leaves the trigger straight onto it", async () => {
  const trigger = await mount();
  await hover(trigger);
  await move(trigger, document.querySelector<HTMLElement>("#inside")!);
  await advance(2_000);
  expect(card()).not.toBeNull();
});

it("keeps the card when focus moves from the trigger into it", async () => {
  // Chromium focuses a button on mousedown, so pressing a control in the card
  // blurs the trigger first. Hiding on that blur unmounted the control before
  // its click could land.
  const trigger = await mount();
  await act(async () => trigger.focus());
  expect(card()).not.toBeNull();

  await act(async () => document.querySelector<HTMLElement>("#inside")!.focus());
  expect(card()).not.toBeNull();
  await act(async () => document.querySelector<HTMLElement>("#inside")!.click());
  expect(action).toHaveBeenCalledOnce();
});

it("leaves a plain tooltip's leave instant", async () => {
  const trigger = await mount({ interactive: false });
  await hover(trigger);
  expect(card()?.textContent).toBe("Plain tooltip");
  await move(trigger, document.body);
  expect(card()).toBeNull();
});

it("bridges the gap between a card and its trigger", async () => {
  // jsdom has no layout. Put the trigger near the bottom right, as the rail's
  // footer is, and give the card a size, so placement puts it above.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.id === "trigger") {
        return { left: 900, right: 930, top: 700, bottom: 716, width: 30, height: 16, x: 900, y: 700, toJSON: () => ({}) } as DOMRect;
      }
      if (this.getAttribute("role") === "dialog") {
        return { left: 0, right: 380, top: 0, bottom: 150, width: 380, height: 150, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
  );
  const trigger = await mount();
  await hover(trigger);

  const el = card()!;
  // Centred on the trigger, clamped 12px inside a 1024px viewport, 8px above.
  expect(el.style.left).toBe("632px");
  expect(el.style.top).toBe("542px");

  const bridge = el.querySelector<HTMLElement>("[data-tooltip-bridge]");
  expect(bridge).not.toBeNull();
  // Hangs off the card's bottom edge down to the trigger's top, and is part of
  // the card, so a pointer on it is a pointer on the card.
  expect(bridge!.style.top).toBe("100%");
  expect(parseFloat(bridge!.style.height)).toBeGreaterThanOrEqual(8);
  expect(bridge!.style.pointerEvents).toBe("auto");
  expect(bridge!.getAttribute("aria-hidden")).toBe("true");

  await move(trigger, bridge);
  await advance(2_000);
  expect(card()).not.toBeNull();
});

it("draws no bridge for a plain tooltip", async () => {
  const trigger = await mount({ interactive: false });
  await hover(trigger);
  expect(card()!.querySelector("[data-tooltip-bridge]")).toBeNull();
});

it("pins a clicked card until the user dismisses it", async () => {
  const trigger = await mount({ pinnable: true });
  await hover(trigger);
  await act(async () => trigger.click());

  // A pinned card belongs to the user: wandering off is not a dismissal.
  await move(trigger, elsewhere());
  await advance(2_000);
  expect(card()).not.toBeNull();

  // Pressing inside it is not "elsewhere" either.
  const inside = document.querySelector<HTMLElement>("#inside")!;
  await act(async () => {
    inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await act(async () => inside.click());
  expect(action).toHaveBeenCalledOnce();
  expect(card()).not.toBeNull();

  // A press anywhere else is.
  await act(async () => {
    elsewhere().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(card()).toBeNull();
});

it("closes a pinned card on Escape", async () => {
  const trigger = await mount({ pinnable: true });
  await act(async () => trigger.click());
  expect(card()).not.toBeNull();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(card()).toBeNull();
});

it("takes a keyboard user into the card they pinned", async () => {
  const trigger = await mount({ pinnable: true });
  await act(async () => trigger.focus());
  // Enter and Space on a button dispatch a click with `detail` 0.
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
  expect(document.activeElement?.id).toBe("inside");
});
