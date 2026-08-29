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
    "--- old",
    "+++ new",
    " after",
    ""
  ].join("\n");
  const lines = [
    {
      id: "h:0:2:2:d:2",
      kind: "delete" as const,
      oldLine: 2,
      newLine: null,
      text: "-- old"
    },
    {
      id: "h:0:2:2:a:2",
      kind: "add" as const,
      oldLine: null,
      newLine: 2,
      text: "++ new"
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

    // The hunk header's own box leads, then one per changed row.
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]?.indeterminate).toBe(true);
    expect(checkboxes[1]?.checked).toBe(true);
    await act(async () => checkboxes[2]?.click());
    expect(onToggleLine).toHaveBeenCalledWith([lines[1]?.id]);

    const hunkButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stage hunk"
    );
    await act(async () => hunkButton?.click());
    expect(onApply).toHaveBeenCalledWith(lines.map((line) => line.id));
  });

  it("selects a whole hunk from its header box, leading with a row that flips", async () => {
    const onToggleLine = vi.fn();
    await act(async () => {
      root.render(
        <DiffViewer
          patch={textPatch}
          selection={{
            staged: false,
            // One of the two already ticked, so the header box is partial and
            // its click has to complete the hunk rather than invert it.
            selectedIds: new Set([lines[0]!.id]),
            applying: false,
            hunks: [
              { id: "h:0:2:2", header: "@@ -2 +2 @@", lineSelection: true, lines }
            ],
            onToggleLine,
            onApply: vi.fn()
          }}
        />
      );
    });

    const header = container.querySelector(".diff-select--hunk");
    await act(async () => (header as HTMLElement).click());
    // Unticked row first: the pane follows the lead, so the run is checked.
    expect(onToggleLine).toHaveBeenCalledWith([lines[1]?.id, lines[0]?.id]);
  });

  it("sends the run a shift-click spans, led by the anchor", async () => {
    const onToggleLine = vi.fn();
    await act(async () => {
      root.render(
        <DiffViewer
          patch={textPatch}
          selection={{
            staged: false,
            selectedIds: new Set(),
            applying: false,
            hunks: [
              { id: "h:0:2:2", header: "@@ -2 +2 @@", lineSelection: true, lines }
            ],
            onToggleLine,
            onApply: vi.fn()
          }}
        />
      );
    });

    const rows = container.querySelectorAll(".diff-row.is-tickable");
    expect(rows).toHaveLength(2);
    // The gutter is part of the target; the code column deliberately is not,
    // so a click there still starts a text selection. Aim at the FIRST gutter
    // on purpose: on an added row that is the empty old-line cell, which is
    // baseline-collapsed to no height, so the row — not the cell — is what
    // actually receives the click.
    const gutterOf = (row: Element): HTMLElement =>
      row.querySelector(".diff-gutter") as HTMLElement;
    await act(async () => gutterOf(rows[0]!).click());
    expect(onToggleLine).toHaveBeenLastCalledWith([lines[0]?.id]);
    await act(async () => {
      gutterOf(rows[1]!).dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true })
      );
    });
    expect(onToggleLine).toHaveBeenLastCalledWith([lines[0]?.id, lines[1]?.id]);

    // A pre-existing selection elsewhere on the page must not disable ticking:
    // the guard measures the gesture, it does not ask whether anything is
    // selected. Simulated here by a click whose press and release coincide.
    onToggleLine.mockClear();
    const g = gutterOf(rows[0]!);
    g.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 20 })
    );
    await act(async () =>
      g.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 })
      )
    );
    expect(onToggleLine).toHaveBeenLastCalledWith([lines[0]?.id]);

    // A press and release far apart is a drag that happened to end over the
    // gutter, and must not tick.
    onToggleLine.mockClear();
    g.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 300, clientY: 20 })
    );
    await act(async () =>
      g.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 })
      )
    );
    expect(onToggleLine).not.toHaveBeenCalled();

    // The code column is not a toggle: clicking it must stay inert.
    onToggleLine.mockClear();
    await act(async () =>
      (rows[1]!.querySelector(".diff-text") as HTMLElement).click()
    );
    expect(onToggleLine).not.toHaveBeenCalled();

    // A click that lands on the row itself — the gap an empty, height-less
    // gutter cell leaves behind — still ticks.
    await act(async () => (rows[1] as HTMLElement).click());
    expect(onToggleLine).toHaveBeenLastCalledWith([lines[1]?.id]);
  });

  it("re-seats the shift anchor when a whole hunk is taken from its header", async () => {
    const onToggleLine = vi.fn();
    await act(async () => {
      root.render(
        <DiffViewer
          patch={textPatch}
          selection={{
            staged: false,
            selectedIds: new Set(),
            applying: false,
            hunks: [
              { id: "h:0:2:2", header: "@@ -2 +2 @@", lineSelection: true, lines }
            ],
            onToggleLine,
            onApply: vi.fn()
          }}
        />
      );
    });

    // Tick the first row, so the anchor sits there.
    const rows = container.querySelectorAll(".diff-row.is-tickable");
    await act(async () =>
      (rows[0]!.querySelector(".diff-gutter") as HTMLElement).click()
    );
    // Take the hunk from its header box; the anchor must move into the hunk.
    await act(async () =>
      (container.querySelector(".diff-select--hunk") as HTMLElement).click()
    );
    // A shift-click on the last row now spans from that row, not from row 0.
    onToggleLine.mockClear();
    await act(async () =>
      (rows[1]!.querySelector(".diff-gutter") as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true })
      )
    );
    expect(onToggleLine).toHaveBeenLastCalledWith([lines[1]?.id]);
  });

  it("withholds selection from a patch carrying more than one file", async () => {
    const twoFiles = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,3 +1,3 @@",
      " before",
      "--- old",
      "+++ new",
      " after",
      "diff --git a/other.txt b/other.txt",
      "--- a/other.txt",
      "+++ b/other.txt",
      "@@ -1,3 +1,3 @@",
      " before",
      "-gone",
      "+here",
      " after",
      ""
    ].join("\n");
    await act(async () => {
      root.render(
        <DiffViewer
          patch={twoFiles}
          selection={{
            staged: false,
            selectedIds: new Set(),
            applying: false,
            hunks: [
              { id: "h:0:2:2", header: "@@ -2 +2 @@", lineSelection: true, lines }
            ],
            onToggleLine: vi.fn(),
            onApply: vi.fn()
          }}
        />
      );
    });

    // Coordinates carry no file dimension, so file.txt's line 2 would have
    // ticked other.txt's line 2 as well. Read-only is the safe answer.
    expect(container.querySelectorAll(".diff-file")).toHaveLength(2);
    expect(container.querySelector(".diff-view--selectable")).toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("explains an EOF-sensitive line instead of dropping its box", async () => {
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

    // The boxes stay, disabled and captioned: a row that silently loses its
    // control while its neighbours keep theirs reads as a rendering fault.
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    expect(boxes).toHaveLength(2);
    expect([...boxes].every((box) => box.disabled)).toBe(true);
    expect(boxes[0]?.title).toContain("no trailing newline");
    // No header box either — there is nothing here to tick.
    expect(container.querySelector(".diff-select--hunk")).toBeNull();
    expect(container.querySelector(".diff-row.is-tickable")).toBeNull();
    expect(container.textContent).toContain("Unstage hunk");
  });
});
