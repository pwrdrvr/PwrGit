// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hoverTooltip,
  pinnableTooltip,
  useViewportTooltip
} from "./useViewportTooltip";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const tooltipEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-viewport-tooltip]");

describe("useViewportTooltip owner render isolation", () => {
  it("never re-renders its owner component across hover, move, update, pin, and dismiss sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom(
            "hover-a" as const,
            "hover-b" as const,
            "leave-a" as const,
            "leave-b" as const,
            "pin-a" as const,
            "escape" as const
          ),
          { minLength: 2, maxLength: 14 }
        ),
        async (ops) => {
          let ownerRenders = 0;
          function Owner() {
            ownerRenders += 1;
            const plain = useViewportTooltip();
            const card = useViewportTooltip("commit-context-card", {
              interactive: true,
              trackVisibility: false,
              label: "Details"
            });
            return (
              <div>
                <button id="btn-a" {...hoverTooltip(plain, "Tip A")}>A</button>
                <button id="btn-b" {...pinnableTooltip(card, <span>Card B</span>)}>B</button>
                {plain.tooltipNode}
                {card.tooltipNode}
              </div>
            );
          }

          await act(async () => {
            root.render(<Owner />);
          });
          const baseRenders = ownerRenders;
          const a = container.querySelector<HTMLButtonElement>("#btn-a")!;
          const b = container.querySelector<HTMLButtonElement>("#btn-b")!;

          for (const op of ops) {
            await act(async () => {
              if (op === "hover-a") {
                a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              } else if (op === "hover-b") {
                b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              } else if (op === "leave-a") {
                a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
              } else if (op === "leave-b") {
                b.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
              } else if (op === "pin-a") {
                b.click();
              } else if (op === "escape") {
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
              }
            });
            expect(ownerRenders).toBe(baseRenders);
          }

          // Verify tooltips actually still mount and dismiss properly.
          await act(async () => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          });
          await act(async () => {
            a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          });
          expect(tooltipEl()?.textContent).toBe("Tip A");
          await act(async () => {
            a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
          });
          expect(tooltipEl()).toBeNull();
          expect(ownerRenders).toBe(baseRenders);

          await act(async () => root.unmount());
          root = createRoot(container);
        }
      ),
      { numRuns: 15, seed: 2026112609 }
    );
  });
});
