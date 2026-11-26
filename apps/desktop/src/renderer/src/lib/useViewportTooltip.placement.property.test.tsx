// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hoverTooltip,
  placeViewportTooltip,
  useViewportTooltip,
  type ViewportTooltip
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
  document
    .querySelectorAll("[data-viewport-tooltip-layer]")
    .forEach((node) => node.remove());
  vi.restoreAllMocks();
});

const tooltipEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-viewport-tooltip]");

const domRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  }) as DOMRect;

describe("useViewportTooltip single-pass placement and layer isolation", () => {
  it("measures each plain tooltip at most once per show/update and places it via transform inside the tooltip layer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          vw: fc.integer({ min: 400, max: 1920 }),
          vh: fc.integer({ min: 300, max: 1200 }),
          tipW: fc.integer({ min: 40, max: 320 }),
          tipH: fc.integer({ min: 20, max: 90 }),
          ops: fc.array(
            fc.record({
              kind: fc.constantFrom(
                "hover-a" as const,
                "hover-b" as const,
                "update" as const,
                "leave" as const
              ),
              x: fc.integer({ min: 0, max: 1600 }),
              y: fc.integer({ min: 0, max: 1000 })
            }),
            { minLength: 2, maxLength: 10 }
          )
        }),
        async ({ vw, vh, tipW, tipH, ops }) => {
          Object.defineProperty(window, "innerWidth", {
            configurable: true,
            value: vw
          });
          Object.defineProperty(window, "innerHeight", {
            configurable: true,
            value: vh
          });

          let tooltipReads = 0;
          let targetRectA = domRect(40, 60, 80, 24);
          let targetRectB = domRect(220, 120, 90, 24);
          vi.spyOn(
            HTMLElement.prototype,
            "getBoundingClientRect"
          ).mockImplementation(function (this: HTMLElement) {
            if (this.hasAttribute("data-viewport-tooltip")) {
              tooltipReads += 1;
              return domRect(0, 0, tipW, tipH);
            }
            if (this.id === "btn-a") return targetRectA;
            if (this.id === "btn-b") return targetRectB;
            return domRect(0, 0, 0, 0);
          });

          let handle!: ViewportTooltip;
          function Owner() {
            const tip = useViewportTooltip();
            handle = tip;
            return (
              <div>
                <button id="btn-a" {...hoverTooltip(tip, "Tip A")}>
                  A
                </button>
                <button id="btn-b" {...hoverTooltip(tip, "Tip B")}>
                  B
                </button>
                {tip.tooltipNode}
              </div>
            );
          }

          await act(async () => {
            root.render(<Owner />);
          });
          const a = container.querySelector<HTMLButtonElement>("#btn-a")!;
          const b = container.querySelector<HTMLButtonElement>("#btn-b")!;
          let activeRect: DOMRect | null = null;
          let updateCount = 0;

          for (const op of ops) {
            const readsBefore = tooltipReads;
            if (op.kind === "hover-a") {
              targetRectA = domRect(
                Math.min(op.x, vw - 40),
                Math.min(op.y, vh - 24),
                40,
                24
              );
              activeRect = targetRectA;
              await act(async () => {
                a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              });
            } else if (op.kind === "hover-b") {
              targetRectB = domRect(
                Math.min(op.x, vw - 40),
                Math.min(op.y, vh - 24),
                40,
                24
              );
              activeRect = targetRectB;
              await act(async () => {
                b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              });
            } else if (op.kind === "update") {
              updateCount += 1;
              await act(async () => {
                handle.update(`Updated ${updateCount}`);
              });
            } else {
              activeRect = null;
              await act(async () => {
                a.dispatchEvent(
                  new MouseEvent("mouseout", {
                    bubbles: true,
                    relatedTarget: document.body
                  })
                );
              });
            }

            const readsDelta = tooltipReads - readsBefore;
            if (activeRect === null) {
              expect(tooltipEl()).toBeNull();
              expect(readsDelta).toBe(0);
            } else {
              // At most one measurement per show/update: no second render pass
              // re-measuring after placement.
              expect(readsDelta).toBeLessThanOrEqual(1);
              const el = tooltipEl()!;
              expect(el).not.toBeNull();
              expect(
                el.parentElement?.hasAttribute("data-viewport-tooltip-layer")
              ).toBe(true);
              expect(el.style.left).toBe("0px");
              expect(el.style.top).toBe("0px");
              expect(el.style.visibility).toBe("");
              const expected = placeViewportTooltip({
                target: {
                  left: activeRect.left,
                  right: activeRect.right,
                  top: activeRect.top,
                  bottom: activeRect.bottom
                },
                tooltip: { width: tipW, height: tipH },
                viewport: { width: vw, height: vh }
              });
              expect(el.style.transform).toBe(
                `translate(${expected.left}px, ${expected.top}px)`
              );
            }
          }

          await act(async () => root.unmount());
          root = createRoot(container);
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 30 }
    );
  });

  it("measures an interactive hover card at most once when mounting with a hover bridge", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 768
    });

    let dialogReads = 0;
    vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect"
    ).mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "dialog") {
        dialogReads += 1;
        return domRect(0, 0, 380, 150);
      }
      if (this.id === "trigger") return domRect(900, 700, 30, 16);
      return domRect(0, 0, 0, 0);
    });

    function Owner() {
      const tip = useViewportTooltip("commit-context-card", {
        interactive: true,
        label: "Commit context"
      });
      return (
        <div>
          <button id="trigger" {...hoverTooltip(tip, <span>Details</span>)}>
            Open
          </button>
          {tip.tooltipNode}
        </div>
      );
    }

    await act(async () => {
      root.render(<Owner />);
    });
    const trigger = container.querySelector<HTMLButtonElement>("#trigger")!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const el = tooltipEl()!;
    expect(el.style.left).toBe("632px");
    expect(el.style.top).toBe("542px");
    expect(el.querySelector("[data-tooltip-bridge]")).not.toBeNull();
    expect(dialogReads).toBe(1);
  });
});
