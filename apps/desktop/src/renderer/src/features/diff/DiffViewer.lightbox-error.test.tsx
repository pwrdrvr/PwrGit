// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const showErrorToastMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
vi.mock("../../lib/toast", () => ({ showErrorToast: showErrorToastMock }));
// The real lightbox, made to throw on a later render: once both revisions
// have decoded and there is a comparison to plan. That is the shape of the
// 2026-10-05 report — a 24×36 → 256×384 pair went blank once it loaded — and
// it means the lightbox has already mounted and taken focus when it fails.
vi.mock("./use-pixel-diff", () => ({
  usePixelDiff: ({ plan }: { plan: unknown }) => {
    if (plan !== null) throw new Error("planDiff: extent mismatch");
    return { kind: "idle" };
  }
}));

import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";
import {
  installObjectUrlLedger,
  type ObjectUrlLedger
} from "../../test-support/object-urls";

const REVISIONS: ImageDiffRevisions = {
  worktreeId: "wt-1",
  before: { kind: "index" },
  after: { kind: "worktree" }
};

const PATCH = [
  "diff --git a/art/icon.png b/art/icon.png",
  "index 1111111..2222222 100644",
  "Binary files a/art/icon.png and b/art/icon.png differ",
  ""
].join("\n");

let container: HTMLDivElement;
let root: Root;
let urls: ObjectUrlLedger;

/** Report a decode the way Chromium would, for every picture on the page. */
async function decode(before: [number, number], after: [number, number]): Promise<void> {
  await act(async () => {
    document.querySelectorAll("img").forEach((img) => {
      const alt = img.getAttribute("alt") ?? "";
      const size = alt.endsWith(", before") ? before : alt.endsWith(", after") ? after : null;
      if (size === null) return;
      Object.defineProperty(img, "naturalWidth", { value: size[0], configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: size[1], configurable: true });
      img.dispatchEvent(new Event("load"));
    });
  });
}

const frame = (): HTMLButtonElement | null =>
  container.querySelector("button.diff-image__frame");

async function openAndBreak(): Promise<void> {
  await act(async () => {
    root.render(<DiffViewer patch={PATCH} images={REVISIONS} />);
  });
  await decode([24, 36], [256, 384]);
  // A real click focuses the button it lands on; a synthetic one does not.
  await act(async () => frame()?.focus());
  await act(async () => {
    frame()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(document.querySelector(".image-lightbox")).not.toBeNull();
  // The lightbox takes focus on open, then measures its own copies and throws.
  expect(document.activeElement?.closest(".image-lightbox")).not.toBeNull();
  await decode([24, 36], [256, 384]);
}

beforeEach(() => {
  showErrorToastMock.mockClear();
  dispatchMock.mockImplementation(async (name: string) =>
    name === "diff:image"
      ? ok({ kind: "image", mediaType: "image/png", bytes: new Uint8Array(2048) })
      : ok(null)
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  urls = installObjectUrlLedger();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  urls.restore();
  vi.restoreAllMocks();
});

describe("DiffViewer when the image lightbox throws", () => {
  it("closes the lightbox, keeps the diff, and says what happened", async () => {
    await openAndBreak();

    // Not a blank window: the lightbox is gone and the row under it remains.
    expect(document.querySelector(".image-lightbox")).toBeNull();
    expect(container.querySelector(".diff-file")).not.toBeNull();
    expect(container.textContent).toContain("art/icon.png");

    expect(showErrorToastMock).toHaveBeenCalledTimes(1);
    expect(showErrorToastMock.mock.calls[0]![0]).toMatchObject({
      title: "Couldn’t show the image viewer",
      detail: "planDiff: extent mismatch",
      subject: { worktreeId: "wt-1" }
    });
  });

  it("hands focus back to the opener, so the pane's Escape still works", async () => {
    await openAndBreak();
    // DiffPane's Escape is scoped to focus being inside the pane; focus left
    // on <body> would make it silently do nothing.
    expect(document.activeElement).toBe(frame());
  });

  it("opens again on the next click rather than staying stuck", async () => {
    await openAndBreak();
    await act(async () => {
      frame()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await decode([24, 36], [256, 384]);
    expect(showErrorToastMock).toHaveBeenCalledTimes(2);
  });
});
