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

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
