// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ImagePreview } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

import { ImageDiff, type ImageDiffRevisions } from "./ImageDiff";
import type { DiffFile } from "./parse-diff";
import {
  installObjectUrlLedger,
  type ObjectUrlLedger
} from "../../test-support/object-urls";

let container: HTMLDivElement;
let root: Root;
let urls: ObjectUrlLedger;

const REVISIONS: ImageDiffRevisions = {
  worktreeId: "wt-1",
  before: { kind: "index" },
  after: { kind: "worktree" }
};

/** Raw bytes, as main now sends them: 2 KB whose first byte tells the
 *  revisions apart. */
const png = (tag: number): ImagePreview => {
  const bytes = new Uint8Array(2048);
  bytes[0] = tag;
  return { kind: "image", mediaType: "image/png", bytes };
};

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

async function render(file: DiffFile, strict = false): Promise<void> {
  const row = <ImageDiff file={file} revisions={REVISIONS} />;
  await act(async () => {
    root.render(strict ? <StrictMode>{row}</StrictMode> : row);
  });
}

const images = (): HTMLImageElement[] =>
  Array.from(container.querySelectorAll("img"));

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

beforeEach(() => {
  urls = installObjectUrlLedger();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  urls.restore();
  vi.clearAllMocks();
});

/** First byte of the Blob behind a displayed URL. */
async function tagOf(src: string): Promise<number | undefined> {
  const blob = urls.minted.get(src);
  if (blob === undefined) return undefined;
  return new Uint8Array(await blob.arrayBuffer())[0];
}

describe("ImageDiff", () => {
  it("renders both revisions through blob URLs over the raw bytes", async () => {
    dispatchMock.mockImplementation(async (_name, req) =>
      ok(png(req.rev.kind === "index" ? 1 : 2))
    );

    await render(binaryFile());

    const srcs = images().map((img) => img.getAttribute("src") ?? "");
    expect(srcs.every((src) => src.startsWith("blob:"))).toBe(true);
    expect(await Promise.all(srcs.map(tagOf))).toEqual([1, 2]);
    expect(srcs.map((src) => urls.minted.get(src)?.type)).toEqual([
      "image/png",
      "image/png"
    ]);
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
    expect(container.textContent).toContain("2.0 KB");
  });

  it("asks only for the new side of an added file", async () => {
    dispatchMock.mockResolvedValue(ok(png(2)));

    await render(binaryFile({ status: "added" }));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[1]).toMatchObject({
      path: "art/logo.png",
      rev: { kind: "worktree" }
    });
    expect(images()).toHaveLength(1);
  });

  it("reads the old path for the before side of a rename", async () => {
    dispatchMock.mockResolvedValue(ok(png(3)));

    await render(
      binaryFile({ status: "renamed", oldPath: "art/old-logo.png" })
    );

    const paths = dispatchMock.mock.calls.map((call) => call[1].path);
    expect(paths).toEqual(["art/old-logo.png", "art/logo.png"]);
  });

  it("drops dimensions measured from a revision no longer on screen", async () => {
    dispatchMock.mockResolvedValue(ok(png(2)));
    await render(binaryFile({ status: "added" }));

    // Report a decode for the first revision the way the browser would.
    await decode([{ w: 40, h: 30 }]);
    expect(container.textContent).toContain("40×30");

    // Second revision whose bytes never decode — no load event follows, so the
    // earlier dimensions must not be reported against the new blob.
    dispatchMock.mockResolvedValue(ok(png(4)));
    await render(binaryFile({ status: "added", path: "art/other.png" }));
    expect(container.textContent).not.toContain("40×30");
  });

  it("skips the before side when the old path was not an image", async () => {
    dispatchMock.mockResolvedValue(ok(png(2)));

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
      ok({ kind: "tooLarge", sizeBytes: 24 * 1024 * 1024 })
    );

    await render(binaryFile({ status: "added" }));

    expect(container.textContent).toContain("24.0 MB — too large to preview");
  });
});

describe("ImageDiff blob URL ownership", () => {
  it("revokes a file's URLs when the row moves on to another file", async () => {
    dispatchMock.mockResolvedValue(ok(png(2)));
    await render(binaryFile({ status: "added" }));
    const first = images()[0]?.getAttribute("src") ?? "";
    expect(urls.live()).toEqual([first]);

    await render(binaryFile({ status: "added", path: "art/other.png" }));
    const second = images()[0]?.getAttribute("src") ?? "";

    expect(second).not.toBe(first);
    expect(urls.revoked).toContain(first);
    expect(urls.live()).toEqual([second]);
  });

  it("revokes everything it minted when the row unmounts", async () => {
    dispatchMock.mockImplementation(async (_name, req) =>
      ok(png(req.rev.kind === "index" ? 1 : 2))
    );
    await render(binaryFile());
    expect(urls.live()).toHaveLength(2);

    await act(async () => root.unmount());
    root = createRoot(container);

    expect(urls.live()).toEqual([]);
  });

  // StrictMode rehearses an unmount: it runs every effect's cleanup and then
  // the effect again. A store built in useMemo and disposed by an effect
  // cleanup survives that rehearsal only as a disposed husk, and the row goes
  // on showing URLs it has already revoked — which is what bit PwrAgent.
  it("never shows a URL it has revoked, under StrictMode", async () => {
    dispatchMock.mockImplementation(async (_name, req) =>
      ok(png(req.rev.kind === "index" ? 1 : 2))
    );

    await render(binaryFile(), true);

    const srcs = images().map((img) => img.getAttribute("src") ?? "");
    expect(srcs).toHaveLength(2);
    for (const src of srcs) {
      expect(urls.minted.has(src)).toBe(true);
      expect(urls.revoked).not.toContain(src);
    }
    expect(await Promise.all(srcs.map(tagOf))).toEqual([1, 2]);
  });
});
