// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowFrameState } from "@pwrgit/shared";
import { WindowControls } from "./WindowControls";

let container: HTMLDivElement;
let root: Root;
const runWindowControl = vi.fn();
const readWindowFrameState = vi.fn();
const stopListening = vi.fn();
let pushFrameState: ((state: WindowFrameState) => void) | undefined;

beforeEach(() => {
  runWindowControl.mockResolvedValue(null);
  readWindowFrameState.mockResolvedValue({ maximized: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(window, "pwrgit", {
    configurable: true,
    value: {
      profileId: null,
      platform: "linux",
      dispatch: vi.fn(),
      on: vi.fn(),
      runWindowControl,
      readWindowFrameState,
      onWindowFrameState: (handler: (state: WindowFrameState) => void) => {
        pushFrameState = handler;
        return stopListening;
      }
    }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  runWindowControl.mockReset();
  readWindowFrameState.mockReset();
  stopListening.mockReset();
  pushFrameState = undefined;
  Reflect.deleteProperty(window, "pwrgit");
});

async function renderControls(): Promise<void> {
  await act(async () => {
    root.render(<WindowControls />);
  });
}

function button(label: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${label}"]`);
}

describe("Linux caption buttons", () => {
  it("draws the three buttons no Linux frame gives us", async () => {
    await renderControls();
    expect(button("Minimize")).not.toBeNull();
    expect(button("Maximize")).not.toBeNull();
    expect(button("Close")).not.toBeNull();
  });

  it("asks main to act on the window it is painted in", async () => {
    await renderControls();
    await act(async () => button("Minimize")?.click());
    await act(async () => button("Close")?.click());
    expect(runWindowControl.mock.calls).toEqual([["minimize"], ["close"]]);
  });

  it("opens on Restore when the window is already maximized", async () => {
    readWindowFrameState.mockResolvedValue({ maximized: true });
    await renderControls();
    expect(button("Restore")).not.toBeNull();
    expect(button("Maximize")).toBeNull();
  });

  it("follows a maximize that never went through the button", async () => {
    await renderControls();
    expect(button("Maximize")).not.toBeNull();

    await act(async () => pushFrameState?.({ maximized: true }));
    expect(button("Restore")).not.toBeNull();

    await act(async () => pushFrameState?.({ maximized: false }));
    expect(button("Maximize")).not.toBeNull();
  });

  it("redraws from the state the action answers with", async () => {
    runWindowControl.mockResolvedValue({ maximized: true });
    await renderControls();
    await act(async () => button("Maximize")?.click());
    expect(button("Restore")).not.toBeNull();
  });

  it("stops listening when the strip goes away", async () => {
    await renderControls();
    await act(async () => root.render(null));
    expect(stopListening).toHaveBeenCalledOnce();
  });
});
