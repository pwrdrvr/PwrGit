// @vitest-environment jsdom

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Page } from "@playwright/test";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSidebarWidth } from "../../../../e2e/fixtures/sidebar-width";
import { PaneResizer } from "../features/shell/PaneResizer";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH
} from "../features/sidebar/repo-index";
import { useColumnResize } from "./useColumnResize";

const KEY = "pwrgit.sidebarWidth";
let container: HTMLDivElement;
let root: Root;

function Harness() {
  const resize = useColumnResize(
    KEY, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, "left"
  );
  return createElement(PaneResizer, {
    ...resize,
    side: "left",
    offset: resize.width,
    onNudge: resize.nudge,
    onReset: resize.reset,
    ariaLabel: "Resize sidebar"
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
  window.localStorage.clear();
  vi.useRealTimers();
});

async function scenario(target: number, mountAge: number, commandLag: number): Promise<void> {
  window.localStorage.clear();
  const mount = async (): Promise<void> => {
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  };
  const unmount = async (): Promise<void> => {
    await act(async () => root.unmount());
  };
  const tick = async (ms: number): Promise<void> => {
    await act(async () => vi.advanceTimersByTime(ms));
  };
  const separator = (): HTMLElement => container.querySelector("[role=separator]")!;
  const width = (): number => Number(separator().getAttribute("aria-valuenow"));
  let pointerX = 0;
  let pressed = false;

  // Only the browser transport/layout is simulated. The helper, hook, 200ms
  // persistence timer, React pointer handlers and remount are real.
  // Keep evaluate/reload to replay the original storage-based setup too.
  const page = {
    evaluate: async (fn: (value: number) => void, value: number) => fn(value),
    reload: async () => {
      await tick(commandLag);
      await unmount();
      await mount();
    },
    getByRole: () => ({
      getAttribute: async (name: string) => separator().getAttribute(name),
      boundingBox: async () => ({ x: width() - 3, y: 0, width: 6, height: 600 })
    }),
    mouse: {
      move: async (x: number) => {
        pointerX = x;
        await tick(commandLag);
        if (pressed) {
          await act(async () => document.dispatchEvent(
            new MouseEvent("pointermove", { bubbles: true, clientX: x })
          ));
        }
      },
      down: async () => {
        pressed = true;
        await act(async () => separator().dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, clientX: pointerX })
        ));
      },
      up: async () => {
        pressed = false;
        await act(async () => document.dispatchEvent(new MouseEvent("pointerup")));
      }
    }
  } as unknown as Page;

  await mount();
  try {
    await tick(mountAge);
    await setSidebarWidth(page, target);
    expect(width()).toBe(target);
    await tick(200);
    expect(Number(window.localStorage.getItem(KEY))).toBe(target);
    await unmount();
    await mount();
    expect(width()).toBe(target);
  } finally {
    await unmount();
  }
}

// Layout tests must establish the requested width regardless of whether the
// mount's debounced save runs before, during or after their browser commands.
it("sets and preserves every allowed sidebar width across the mount save", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH }),
    fc.integer({ min: 0, max: 400 }),
    fc.integer({ min: 0, max: 400 }),
    scenario
  ));
});

it("sets 240 while the pending mount save writes 320 between commands", async () => {
  await scenario(240, 0, 200);
});
