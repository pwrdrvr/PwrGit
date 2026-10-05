// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ImagePreview } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

import { ImageLightbox } from "./ImageLightbox";
import type { DiffFile } from "./parse-diff";
import type {
  ImageDiffRevisions,
  SideSeed,
  SideState
} from "./use-image-revisions";
import {
  installObjectUrlLedger,
  type ObjectUrlLedger
} from "../../test-support/object-urls";

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
  bytes: new Uint8Array(2048)
};

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;
let urls: ObjectUrlLedger;

beforeEach(() => {
  urls = installObjectUrlLedger();
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
  urls.restore();
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

    act(() => list.at(-1)!.focus());
    press(document.activeElement!, "Tab");
    expect(document.activeElement).toBe(list[0]);
    press(document.activeElement!, "Tab", true);
    expect(document.activeElement).toBe(list.at(-1));
  });

  it("keeps Shift+Tab inside when the frame holds focus, as it does on open", async () => {
    await open();
    expect(document.activeElement).toBe(dialog().querySelector(".image-lightbox__frame"));
    press(document.activeElement!, "Tab", true);
    expect(name(document.activeElement)).toBe("Zoom in");
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

describe("ImageLightbox blob URL ownership", () => {
  /** What a row on screen hands over: its Blobs, behind URLs IT minted. */
  function rowSeed(): { seed: SideSeed; rowSrcs: string[] } {
    const side = (tag: number): SideState => {
      const blob = new Blob([new Uint8Array([tag])], { type: "image/png" });
      return { kind: "image", blob, src: URL.createObjectURL(blob) };
    };
    const states = { before: side(1), after: side(2) };
    const rowSrcs = [states.before, states.after].map((state) =>
      state.kind === "image" ? state.src : ""
    );
    return { seed: { path: FILE.path, states }, rowSrcs };
  }

  const shown = (): string[] =>
    [...document.querySelectorAll<HTMLImageElement>(".image-lightbox__img")].map(
      (img) => img.getAttribute("src") ?? ""
    );

  // The seeded path is the one StrictMode's rehearsal really exercises: the
  // first run mints URLs synchronously, its cleanup revokes them, and only the
  // second run's URLs may end up on screen.
  it("shows only URLs it still holds, under StrictMode", async () => {
    const { seed, rowSrcs } = rowSeed();
    await act(async () => {
      root.render(
        <StrictMode>
          <ImageLightbox
            files={[FILE]}
            revisions={REVISIONS}
            at={0}
            seed={seed}
            onMove={() => undefined}
            onClose={() => undefined}
          />
        </StrictMode>
      );
    });

    const srcs = shown();
    expect(srcs).toHaveLength(2);
    // The rehearsal ran and released what it made — else this proves nothing.
    expect(urls.revoked.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(urls.minted.has(src)).toBe(true);
      expect(urls.revoked).not.toContain(src);
    }
    // Seeded sides cost no IPC.
    expect(dispatchMock).not.toHaveBeenCalled();
    // Same bytes as the row's, through URLs of its own.
    expect(srcs.some((src) => rowSrcs.includes(src))).toBe(false);
    expect(srcs.map((src) => urls.minted.get(src))).toEqual([
      seed.states.before.kind === "image" ? seed.states.before.blob : null,
      seed.states.after.kind === "image" ? seed.states.after.blob : null
    ]);
  });

  it("releases its own URLs on close and leaves the row's alone", async () => {
    const { seed, rowSrcs } = rowSeed();
    await act(async () => {
      root.render(
        <ImageLightbox
          files={[FILE]}
          revisions={REVISIONS}
          at={0}
          seed={seed}
          onMove={() => undefined}
          onClose={() => undefined}
        />
      );
    });
    const mine = shown();

    await act(async () => root.unmount());
    root = createRoot(container);

    for (const src of mine) expect(urls.revoked).toContain(src);
    expect(urls.live()).toEqual(rowSrcs);
  });
});
