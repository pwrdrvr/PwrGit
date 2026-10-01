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

/** jsdom's Range has no layout; give it the fractional widths Chromium reports. */
const withTextWidth = async (
  text: number,
  box: number,
  run: (name: HTMLElement) => Promise<void>
): Promise<void> => {
  const rect = (width: number) =>
    ({
      width,
      height: 20,
      left: 0,
      right: width,
      top: 0,
      bottom: 20,
      x: 0,
      y: 0
    }) as DOMRect;
  const proto = Range.prototype as { getBoundingClientRect?: () => DOMRect };
  proto.getBoundingClientRect = () => rect(text);
  try {
    // Both whole pixels read equal, as they do for a subpixel overhang.
    const name = await mount({ scrollWidth: 103, clientWidth: 103 });
    name.getBoundingClientRect = () => rect(box);
    await run(name);
  } finally {
    delete proto.getBoundingClientRect;
  }
};

it("shows the name cut short by less than a pixel, which whole-pixel widths miss", async () => {
  // Measured in Chromium: "PwrGitPwr…" with both widths reading 103.
  await withTextWidth(103.125, 102.82, async (name) => {
    await act(async () => {
      name.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(card()?.textContent).toBe("PwrGit");
  });
});

it("opens nothing when the text exactly fills its box", async () => {
  await withTextWidth(103, 103, async (name) => {
    await act(async () => {
      name.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(card()).toBeNull();
  });
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
