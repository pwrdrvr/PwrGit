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

describe("DiffViewer hunk and line selection", () => {
  const textPatch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,3 +1,3 @@",
    " before",
    "-old",
    "+new",
    " after",
    ""
  ].join("\n");
  const lines = [
    {
      id: "h:0:2:2:d:2",
      kind: "delete" as const,
      oldLine: 2,
      newLine: null,
      text: "old"
    },
    {
      id: "h:0:2:2:a:2",
      kind: "add" as const,
      oldLine: null,
      newLine: 2,
      text: "new"
    }
  ];

  it("routes individual checkboxes and the whole visible hunk through typed IDs", async () => {
    const onToggleLine = vi.fn();
    const onApply = vi.fn();
    await act(async () => {
      root.render(
        <DiffViewer
          patch={textPatch}
          selection={{
            staged: false,
            selectedIds: new Set([lines[0]!.id]),
            applying: false,
            hunks: [
              {
                id: "h:0:2:2",
                header: "@@ -2 +2 @@",
                lineSelection: true,
                lines
              }
            ],
            onToggleLine,
            onApply
          }}
        />
      );
    });

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]?.checked).toBe(true);
    await act(async () => checkboxes[1]?.click());
    expect(onToggleLine).toHaveBeenCalledWith(lines[1]?.id);

    const hunkButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stage hunk"
    );
    await act(async () => hunkButton?.click());
    expect(onApply).toHaveBeenCalledWith(lines.map((line) => line.id));
  });

  it("keeps an EOF-sensitive change hunk-selectable but hides unsafe line toggles", async () => {
    await act(async () => {
      root.render(
        <DiffViewer
          patch={textPatch}
          selection={{
            staged: true,
            selectedIds: new Set(),
            applying: false,
            hunks: [
              {
                id: "h:0:2:2",
                header: "@@ -2 +2 @@",
                lineSelection: false,
                lines
              }
            ],
            onToggleLine: vi.fn(),
            onApply: vi.fn()
          }}
        />
      );
    });

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(container.textContent).toContain("Unstage hunk");
  });
});
