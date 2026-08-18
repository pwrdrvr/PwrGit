// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));

import { DiffViewer } from "./DiffViewer";
import type { ImageDiffRevisions } from "./ImageDiff";

let container: HTMLDivElement;
let root: Root;

const REVISIONS: ImageDiffRevisions = {
  worktreeId: "wt-1",
  before: { kind: "index" },
  after: { kind: "worktree" }
};

const binaryPatch = (path: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    `Binary files /dev/null and b/${path} differ`,
    ""
  ].join("\n");

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

describe("DiffViewer binary files", () => {
  it("previews a binary image when the revisions to compare are known", async () => {
    dispatchMock.mockResolvedValue(
      ok({ kind: "image", mediaType: "image/gif", base64: "R0lG", bytes: 4 })
    );

    await act(async () => {
      root.render(
        <DiffViewer patch={binaryPatch("art/anim.gif")} images={REVISIONS} />
      );
    });

    expect(container.querySelector("img")?.src).toBe(
      "data:image/gif;base64,R0lG"
    );
    expect(container.textContent).not.toContain("no preview");
  });

  it("keeps the plain notice for a binary file that is not an image", async () => {
    await act(async () => {
      root.render(
        <DiffViewer patch={binaryPatch("bin/tool.wasm")} images={REVISIONS} />
      );
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Binary file — no preview.");
  });

  it("keeps the plain notice when no revisions were supplied", async () => {
    await act(async () => {
      root.render(<DiffViewer patch={binaryPatch("art/anim.gif")} />);
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Binary file — no preview.");
  });
});
