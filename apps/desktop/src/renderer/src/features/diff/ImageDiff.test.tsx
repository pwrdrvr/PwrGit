// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ImagePreview } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

import { ImageDiff, type ImageDiffRevisions } from "./ImageDiff";
import type { DiffFile } from "./parse-diff";

let container: HTMLDivElement;
let root: Root;

const REVISIONS: ImageDiffRevisions = {
  worktreeId: "wt-1",
  before: { kind: "index" },
  after: { kind: "worktree" }
};

const png = (base64: string): ImagePreview => ({
  kind: "image",
  mediaType: "image/png",
  base64,
  bytes: 2048
});

function binaryFile(over: Partial<DiffFile> = {}): DiffFile {
  return {
    path: "art/logo.png",
    status: "modified",
    hunks: [],
    additions: 0,
    deletions: 0,
    binary: true,
    ...over
  };
}

async function render(file: DiffFile): Promise<void> {
  await act(async () => {
    root.render(<ImageDiff file={file} revisions={REVISIONS} />);
  });
}

const images = (): HTMLImageElement[] =>
  Array.from(container.querySelectorAll("img"));

const frames = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll("button.diff-image__frame"));

const lightbox = (): HTMLElement | null =>
  document.querySelector(".image-lightbox");

/** Report a decode the way Chromium would, so the sides gain natural sizes. */
async function decode(sizes: { w: number; h: number }[]): Promise<void> {
  await act(async () => {
    images().forEach((img, i) => {
      const size = sizes[i];
      if (size === undefined) return;
      Object.defineProperty(img, "naturalWidth", {
        value: size.w,
        configurable: true
      });
      Object.defineProperty(img, "naturalHeight", {
        value: size.h,
        configurable: true
      });
      img.dispatchEvent(new Event("load"));
    });
  });
}

async function click(node: Element | null): Promise<void> {
  await act(async () => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** Cancelable, as a real key event is, so a claim can be observed. */
async function pressCancelable(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true
  });
  await act(async () => {
    window.dispatchEvent(event);
  });
  return event;
}

async function pointer(node: EventTarget | null, type: string): Promise<void> {
  const event = new MouseEvent(type, { bubbles: true });
  // jsdom has no PointerEvent constructor; the pan handler only reads this one
  // field off it before handing it to pointer capture.
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => {
    node?.dispatchEvent(event);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // Pointer capture is what keeps a pan alive once the cursor leaves the
  // stage. Chromium has it and jsdom does not, so stub it here rather than
  // teach the hook to work around a browser it never runs in.
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ImageDiff", () => {
  it("renders both revisions of a modified image as data URLs", async () => {
    dispatchMock.mockImplementation(async (_name, req) =>
      ok(png(req.rev.kind === "index" ? "QkVGT1JF" : "QUZURVI="))
    );

    await render(binaryFile());

    expect(images().map((img) => img.src)).toEqual([
      "data:image/png;base64,QkVGT1JF",
      "data:image/png;base64,QUZURVI="
    ]);
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
    expect(container.textContent).toContain("2.0 KB");
  });

  it("asks only for the new side of an added file", async () => {
    dispatchMock.mockResolvedValue(ok(png("QUZURVI=")));

    await render(binaryFile({ status: "added" }));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[1]).toMatchObject({
      path: "art/logo.png",
      rev: { kind: "worktree" }
    });
    expect(images()).toHaveLength(1);
  });

  it("reads the old path for the before side of a rename", async () => {
    dispatchMock.mockResolvedValue(ok(png("UEFUSA==")));

    await render(
      binaryFile({ status: "renamed", oldPath: "art/old-logo.png" })
    );

    const paths = dispatchMock.mock.calls.map((call) => call[1].path);
    expect(paths).toEqual(["art/old-logo.png", "art/logo.png"]);
  });

  it("drops dimensions measured from a revision no longer on screen", async () => {
    dispatchMock.mockResolvedValue(ok(png("QUZURVI=")));
    await render(binaryFile({ status: "added" }));

    // Report a decode for the first revision the way the browser would.
    const img = images()[0]!;
    Object.defineProperty(img, "naturalWidth", { value: 40, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 30, configurable: true });
    await act(async () => {
      img.dispatchEvent(new Event("load"));
    });
    expect(container.textContent).toContain("40×30");

    // Second revision whose bytes never decode — no load event follows, so the
    // earlier dimensions must not be reported against the new blob.
    dispatchMock.mockResolvedValue(ok(png("Q09SUlVQVA==")));
    await render(binaryFile({ status: "added", path: "art/other.png" }));
    expect(container.textContent).not.toContain("40×30");
  });

  it("skips the before side when the old path was not an image", async () => {
    dispatchMock.mockResolvedValue(ok(png("QUZURVI=")));

    await render(
      binaryFile({ status: "renamed", oldPath: "art/logo.bin" })
    );

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[1]).toMatchObject({
      path: "art/logo.png",
      rev: { kind: "worktree" }
    });
    expect(container.textContent).not.toContain("Could not read the image");
  });

  it("explains an LFS pointer rather than showing a broken image", async () => {
    dispatchMock.mockResolvedValue(ok({ kind: "lfsPointer" }));

    await render(binaryFile({ status: "added" }));

    expect(images()).toHaveLength(0);
    expect(container.textContent).toContain("Git LFS pointer");
  });

  it("names the size it refused to inline", async () => {
    dispatchMock.mockResolvedValue(
      ok({ kind: "tooLarge", bytes: 24 * 1024 * 1024 })
    );

    await render(binaryFile({ status: "added" }));

    expect(container.textContent).toContain("24.0 MB — too large to preview");
  });
});
