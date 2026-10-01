// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { truncatedTooltip, useViewportTooltip } from "./useViewportTooltip";

/**
 * A repo or branch name that fits is already on screen, so a card repeating it
 * is noise; one the ellipsis cut short has no other way to be read. jsdom does
 * no layout, so each case supplies the widths the browser would report.
 */

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function Harness() {
  const tip = useViewportTooltip();
  return (
    <>
      <span id="name" tabIndex={0} {...truncatedTooltip(tip, "PwrGit")}>
        PwrGit
      </span>
      {tip.tooltipNode}
    </>
  );
}

const mount = async (widths: {
  scrollWidth: number;
  clientWidth: number;
}): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const name = container.querySelector<HTMLElement>("#name")!;
  Object.defineProperty(name, "scrollWidth", { value: widths.scrollWidth });
  Object.defineProperty(name, "clientWidth", { value: widths.clientWidth });
  return name;
};

const card = (): Element | null => document.querySelector('[role="tooltip"]');

it("opens nothing for a name that fits", async () => {
  const name = await mount({ scrollWidth: 60, clientWidth: 120 });
  await act(async () => {
    name.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(card()).toBeNull();
  await act(async () => name.focus());
  expect(card()).toBeNull();
});

it("treats a subpixel overhang as fitting", async () => {
  const name = await mount({ scrollWidth: 120.4, clientWidth: 120 });
  await act(async () => {
    name.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(card()).toBeNull();
});

it("shows the full name on hover when the ellipsis cut it short", async () => {
  const name = await mount({ scrollWidth: 180, clientWidth: 120 });
  await act(async () => {
    name.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(card()?.textContent).toBe("PwrGit");
});

it("shows the full name on focus when the ellipsis cut it short", async () => {
  const name = await mount({ scrollWidth: 180, clientWidth: 120 });
  await act(async () => name.focus());
  expect(card()?.textContent).toBe("PwrGit");
});
