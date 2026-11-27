// @vitest-environment jsdom

import fc from "fast-check";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const GUTTER = 8;
const items: MenuItem[] = [
  { type: "item", label: "Pull all repositories", onSelect: () => undefined },
  { type: "item", label: "Sync forks with upstream", checked: true, keepOpen: true, onSelect: () => undefined }
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function mockMenuSize(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({})
  });
}

function readMenuBox(naturalHeight: number): { left: number; top: number; effectiveHeight: number; maxHeight: number | null } {
  const menu = document.querySelector<HTMLElement>(".pop-menu");
  if (!menu) throw new Error("expected .pop-menu to be mounted");
  const left = Number.parseFloat(menu.style.left);
  const top = Number.parseFloat(menu.style.top);
  const maxHeight = menu.style.maxHeight ? Number.parseFloat(menu.style.maxHeight) : null;
  const effectiveHeight = maxHeight === null ? naturalHeight : Math.min(naturalHeight, maxHeight);
  return { left, top, effectiveHeight, maxHeight };
}

describe("ContextMenu placement invariants", () => {
  it("never slides a trigger-anchored below-menu upward over its anchor when the lower half has more room", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 480, max: 1400 }),
        fc.integer({ min: 420, max: 1100 }),
        fc.integer({ min: 180, max: 320 }),
        fc.integer({ min: 120, max: 900 }),
        fc.integer({ min: GUTTER, max: 400 }),
        fc.constantFrom<"start" | "end">("start", "end"),
        (viewportWidth, viewportHeight, menuWidth, menuHeight, rawY, align) => {
          // Keep anchor in the upper half so spaceBelow >= spaceAbove.
          const y = Math.min(rawY, Math.floor(viewportHeight / 2));
          const x = Math.min(200, viewportWidth - GUTTER);
          setViewport(viewportWidth, viewportHeight);
          mockMenuSize(menuWidth, menuHeight);

          const triggerRef = createRef<HTMLButtonElement>();
          const trigger = document.createElement("button");
          triggerRef.current = trigger;

          act(() => {
            root.render(
              <ContextMenu
                x={x}
                y={y}
                align={align}
                placement="below"
                triggerRef={triggerRef}
                items={items}
                onClose={() => undefined}
              />
            );
          });

          const box = readMenuBox(menuHeight);
          // Must never slide upward past y (which would cover the trigger / split button face).
          expect(box.top).toBeGreaterThanOrEqual(y);
          // Must remain inside the viewport vertically and horizontally.
          expect(box.top).toBeGreaterThanOrEqual(GUTTER);
          expect(box.top + box.effectiveHeight).toBeLessThanOrEqual(viewportHeight - GUTTER);
          expect(box.left).toBeGreaterThanOrEqual(GUTTER);
          expect(box.left + menuWidth).toBeLessThanOrEqual(viewportWidth - GUTTER);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("never slides a trigger-anchored above-menu downward over its anchor when the upper half has more room", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 480, max: 1400 }),
        fc.integer({ min: 420, max: 1100 }),
        fc.integer({ min: 180, max: 320 }),
        fc.integer({ min: 120, max: 900 }),
        fc.integer({ min: 0, max: 300 }),
        (viewportWidth, viewportHeight, menuWidth, menuHeight, offsetFromBottom) => {
          // Keep anchor in the lower half so spaceAbove >= spaceBelow.
          const minY = Math.ceil(viewportHeight / 2);
          const maxY = viewportHeight - GUTTER;
          const y = Math.max(minY, maxY - offsetFromBottom);
          setViewport(viewportWidth, viewportHeight);
          mockMenuSize(menuWidth, menuHeight);

          const triggerRef = createRef<HTMLButtonElement>();
          triggerRef.current = document.createElement("button");

          act(() => {
            root.render(
              <ContextMenu
                x={120}
                y={y}
                placement="above"
                triggerRef={triggerRef}
                items={items}
                onClose={() => undefined}
              />
            );
          });

          const box = readMenuBox(menuHeight);
          expect(box.top).toBeGreaterThanOrEqual(GUTTER);
          expect(box.top + box.effectiveHeight).toBeLessThanOrEqual(y);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("always keeps every menu (anchored or pointer) inside the viewport even when taller than the screen", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 480, max: 1400 }),
        fc.integer({ min: 320, max: 1000 }),
        fc.integer({ min: 180, max: 320 }),
        fc.integer({ min: 80, max: 1200 }),
        fc.integer({ min: 0, max: 1400 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.boolean(),
        fc.constantFrom<"below" | "above">("below", "above"),
        (viewportWidth, viewportHeight, menuWidth, menuHeight, rawX, rawY, anchored, placement) => {
          const x = Math.min(rawX, viewportWidth);
          const y = Math.min(rawY, viewportHeight);
          setViewport(viewportWidth, viewportHeight);
          mockMenuSize(menuWidth, menuHeight);

          const triggerRef = createRef<HTMLButtonElement>();
          triggerRef.current = document.createElement("button");

          act(() => {
            root.render(
              <ContextMenu
                x={x}
                y={y}
                placement={placement}
                {...(anchored ? { triggerRef } : {})}
                items={items}
                onClose={() => undefined}
              />
            );
          });

          const box = readMenuBox(menuHeight);
          expect(box.top).toBeGreaterThanOrEqual(GUTTER);
          expect(box.top + box.effectiveHeight).toBeLessThanOrEqual(viewportHeight - GUTTER);
          expect(box.left).toBeGreaterThanOrEqual(GUTTER);
          expect(box.left + menuWidth).toBeLessThanOrEqual(viewportWidth - GUTTER);
        }
      ),
      { numRuns: 60 }
    );
  });

  it("keeps the menu open when scrolling inside it, while outside scroll still dismisses it", () => {
    setViewport(800, 500);
    mockMenuSize(240, 650);
    const onClose = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    triggerRef.current = document.createElement("button");

    act(() => {
      root.render(
        <ContextMenu
          x={80}
          y={132}
          triggerRef={triggerRef}
          items={items}
          onClose={onClose}
        />
      );
    });

    const menu = document.querySelector<HTMLElement>(".pop-menu")!;
    act(() => {
      menu.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    expect(onClose).not.toHaveBeenCalled();

    const outside = document.createElement("div");
    document.body.append(outside);
    try {
      act(() => {
        outside.dispatchEvent(new Event("scroll", { bubbles: false }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      outside.remove();
    }
  });
});
