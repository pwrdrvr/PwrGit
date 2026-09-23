// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ImagePreview } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

import { ImageLightbox } from "./ImageLightbox";
import type { DiffFile } from "./parse-diff";
import type { ImageDiffRevisions } from "./use-image-revisions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const REVISIONS: ImageDiffRevisions = {
  worktreeId: "wt-1",
  before: { kind: "index" },
  after: { kind: "worktree" }
};

const FILE: DiffFile = {
  path: "art/logo.png",
  status: "modified",
  hunks: [],
  additions: 0,
  deletions: 0,
  binary: true
};

const png: ImagePreview = {
  kind: "image",
  mediaType: "image/png",
  base64: "QkVGT1JF",
  bytes: 2048
};

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;

beforeEach(() => {
  dispatchMock.mockResolvedValue(ok(png));
  // The expand button in the diff row, behind the scrim.
  opener = document.createElement("button");
  opener.textContent = "Expand";
  document.body.append(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
  vi.clearAllMocks();
});

async function open(onClose: () => void = () => undefined): Promise<void> {
  await act(async () => {
    root.render(
      <ImageLightbox
        files={[FILE]}
        revisions={REVISIONS}
        at={0}
        onMove={() => undefined}
        onClose={onClose}
      />
    );
  });
}

function press(target: Element, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
    );
  });
}

const dialog = (): HTMLElement =>
  document.querySelector<HTMLElement>('[role="dialog"]')!;
const controls = (): HTMLButtonElement[] =>
  [...dialog().querySelectorAll<HTMLButtonElement>("button")].filter((b) => !b.disabled);
const name = (el: Element | null): string | null =>
  el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? null;

// aria-modal said this was a modal; nothing kept Tab in it, so the zoom
// controls led straight on into the diff behind the scrim (SC 2.4.3).
describe("ImageLightbox as a modal", () => {
  it("wraps Tab from its last control to its first, and back", async () => {
    await open();
    const list = controls();
    expect(name(list[0]!)).toBe("Before");
    expect(name(list.at(-1)!)).toBe("Zoom in");

    list.at(-1)!.focus();
    press(document.activeElement!, "Tab");
    expect(document.activeElement).toBe(list[0]);
    press(document.activeElement!, "Tab", true);
    expect(document.activeElement).toBe(list.at(-1));
  });

  it("pulls focus that reached the diff behind it back inside", async () => {
    await open();
    opener.focus();
    press(opener, "Tab");
    expect(name(document.activeElement)).toBe("Before");
  });

  it("closes its copy menu on Tab and hands the keys back to the viewer", async () => {
    const onClose = vi.fn();
    await open(onClose);
    const stage = dialog().querySelector(".image-lightbox__stage")!;
    act(() => {
      stage.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
      );
    });
    const menu = (): Element | null => document.querySelector('[role="menu"]');
    expect(menu()).not.toBeNull();
    expect(menu()!.contains(document.activeElement)).toBe(true);

    // The menu is portalled outside the frame, so the trap sees this Tab as
    // focus that has escaped. It must still let the menu close itself.
    press(document.activeElement!, "Tab");
    expect(menu()).toBeNull();
    expect(name(document.activeElement)).toBe("Before");

    // The viewer ignores every key while its menu is up, so Escape landing
    // here is the proof the menu's state really cleared.
    press(document.activeElement!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
