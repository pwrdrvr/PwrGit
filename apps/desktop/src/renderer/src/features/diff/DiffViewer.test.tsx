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

/** A binary image that exists on both sides, so it has a before AND an after. */
const modifiedBinaryPatch = (path: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `Binary files a/${path} and b/${path} differ`,
    ""
  ].join("\n");

/** A text file, so the walk has something it must refuse to stop on. */
const textPatch = (path: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    "index 3333333..4444444 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    ""
  ].join("\n");

const anyImage = () =>
  ok({ kind: "image", mediaType: "image/png", base64: "iVBOR", bytes: 2048 });

const frames = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll("button.diff-image__frame"));

const lightbox = (): HTMLElement | null =>
  document.querySelector(".image-lightbox");

const lightboxText = (): string => lightbox()?.textContent ?? "";

/**
 * Report a decode the way Chromium would, so the sides gain natural sizes.
 *
 * Scans the whole document rather than `container`: the lightbox portals to
 * <body>, and it mounts both revisions — the hidden one included — so it can
 * plan a comparison without making the reader visit each item first.
 */
async function decode(sizes: {
  before: { w: number; h: number };
  after: { w: number; h: number };
}): Promise<void> {
  await act(async () => {
    document.querySelectorAll("img").forEach((img) => {
      const alt = img.getAttribute("alt") ?? "";
      const size = alt.endsWith(", before")
        ? sizes.before
        : alt.endsWith(", after")
          ? sizes.after
          : null;
      if (size === null) return;
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

async function decodeAll(size: { w: number; h: number }): Promise<void> {
  await decode({ before: size, after: size });
}

async function click(node: Element | null): Promise<void> {
  await act(async () => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function press(key: string): Promise<KeyboardEvent> {
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

/** Render a patch, let its images decode, and open the first frame. */
async function openLightbox(patch: string): Promise<void> {
  dispatchMock.mockImplementation(async (name: string) =>
    name === "diff:image" ? anyImage() : ok(null)
  );
  await act(async () => {
    root.render(<DiffViewer patch={patch} images={REVISIONS} />);
  });
  await decodeAll({ w: 64, h: 64 });
  // A real click focuses the button it lands on; a synthetic one does not,
  // and where focus sits decides whether the pane behind keeps its Escape.
  frames()[0]?.focus();
  await click(frames()[0] ?? null);
  // The lightbox mounts its own copies of both revisions.
  await decodeAll({ w: 64, h: 64 });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // Pointer capture keeps a pan alive once the cursor leaves the stage.
  // Chromium has it and jsdom does not.
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

  it("selects a whole hunk from its header box with explicit intent", async () => {
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
    // A partially ticked hunk completes: every line, named intent.
    expect(onToggleLine).toHaveBeenCalledWith(
      [lines[0]?.id, lines[1]?.id],
      "check"
    );
  });

  it("sends the run a shift-click spans, following the anchor's state", async () => {
    const onToggleLine = vi.fn();
    await act(async () => {
      root.render(
        <DiffViewer
          patch={textPatch}
          selection={{
            staged: false,
            // The anchor line is already ticked, so extending must CHECK the
            // run — the inversion this contract replaced cleared it instead.
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
    expect(onToggleLine).toHaveBeenLastCalledWith(
      [lines[0]?.id, lines[1]?.id],
      "check"
    );

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
        new MouseEvent("click", {
          bubbles: true,
          detail: 1,
          clientX: 10,
          clientY: 20
        })
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
        new MouseEvent("click", {
          bubbles: true,
          detail: 1,
          clientX: 10,
          clientY: 20
        })
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
    // A shift-click on the last row now spans from that row, not from row 0;
    // the rendered selection is empty at the anchor, so the intent is uncheck.
    onToggleLine.mockClear();
    await act(async () =>
      (rows[1]!.querySelector(".diff-gutter") as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true })
      )
    );
    expect(onToggleLine).toHaveBeenLastCalledWith([lines[1]?.id], "uncheck");
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

describe("DiffViewer image lightbox", () => {
  it("offers before, after and a pixel diff of a modified image", async () => {
    await openLightbox(modifiedBinaryPatch("art/logo.png"));

    expect(
      Array.from(document.querySelectorAll(".image-lightbox__item")).map(
        (tab) => tab.textContent
      )
    ).toEqual(["Before", "After", "Diff"]);
    expect(lightboxText()).toContain("1 / 3 · Before");
  });

  it("contributes one stop for a file with only one side", async () => {
    await openLightbox(binaryPatch("art/added.png"));

    expect(lightbox()).not.toBeNull();
    expect(document.querySelectorAll(".image-lightbox__item")).toHaveLength(0);
    expect(document.querySelectorAll(".image-lightbox__nav")).toHaveLength(0);
  });

  it("walks out of one file's diff and into the next file's before", async () => {
    await openLightbox(
      modifiedBinaryPatch("art/one.png") + modifiedBinaryPatch("art/two.png")
    );

    expect(lightboxText()).toContain("1 / 6 · Before");
    expect(lightboxText()).toContain("file 1/2");
    await press("ArrowRight");
    await press("ArrowRight");
    expect(lightboxText()).toContain("3 / 6 · Diff");
    // The boundary is not a special case for the reader: one more press.
    await press("ArrowRight");
    expect(lightboxText()).toContain("4 / 6 · Before");
    expect(lightboxText()).toContain("file 2/2");
    expect(document.querySelector(".image-lightbox__path")?.textContent).toBe(
      "art/two.png"
    );
  });

  it("stops at both ends rather than wrapping", async () => {
    await openLightbox(
      modifiedBinaryPatch("art/one.png") + modifiedBinaryPatch("art/two.png")
    );

    for (let i = 0; i < 8; i += 1) await press("ArrowRight");
    expect(lightboxText()).toContain("6 / 6 · Diff");
    // Reaching the end and having the arrow do nothing is how you learn you
    // are at the end; a walk that loops silently starts you over instead.
    await press("ArrowRight");
    expect(lightboxText()).toContain("6 / 6 · Diff");

    for (let i = 0; i < 12; i += 1) await press("ArrowLeft");
    expect(lightboxText()).toContain("1 / 6 · Before");
    await press("ArrowLeft");
    expect(lightboxText()).toContain("1 / 6 · Before");
  });

  it("skips files that are not images", async () => {
    await openLightbox(
      textPatch("src/app.ts") +
        modifiedBinaryPatch("art/one.png") +
        textPatch("src/other.ts") +
        modifiedBinaryPatch("art/two.png")
    );

    // Six stops: two image files with three items each. The text files and
    // their hunks are simply not in the walk.
    expect(lightboxText()).toContain("1 / 6 · Before");
    for (let i = 0; i < 3; i += 1) await press("ArrowRight");
    expect(document.querySelector(".image-lightbox__path")?.textContent).toBe(
      "art/two.png"
    );
  });

  it("takes focus, so the pane behind it keeps its own Escape", async () => {
    await openLightbox(modifiedBinaryPatch("art/logo.png"));
    expect(document.activeElement).toBe(
      document.querySelector(".image-lightbox__frame")
    );
  });

  it("claims Escape rather than letting it through to the pane", async () => {
    await openLightbox(modifiedBinaryPatch("art/logo.png"));
    const event = await press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(lightbox()).toBeNull();
    expect(document.activeElement).toBe(frames()[0]);
  });

  it("closes on a click that both starts and ends on the scrim", async () => {
    await openLightbox(modifiedBinaryPatch("art/logo.png"));
    const scrim = lightbox();
    await pointer(scrim, "pointerdown");
    await click(scrim);
    expect(lightbox()).toBeNull();
  });

  it("survives a pan that starts on the image and ends past the frame", async () => {
    await openLightbox(modifiedBinaryPatch("art/logo.png"));
    await pointer(document.querySelector(".image-lightbox__stage"), "pointerdown");
    await click(lightbox());
    expect(lightbox()).not.toBeNull();
  });

  it("says so on the diff when the two revisions are different sizes", async () => {
    dispatchMock.mockImplementation(async (name: string) =>
      name === "diff:image" ? anyImage() : ok(null)
    );
    await act(async () => {
      root.render(
        <DiffViewer
          patch={modifiedBinaryPatch("art/logo.png")}
          images={REVISIONS}
        />
      );
    });
    // Two revisions of the same shape at different resolutions.
    const sizes = {
      before: { w: 3104, h: 2024 },
      after: { w: 1552, h: 1012 }
    };
    await decode(sizes);
    frames()[0]?.focus();
    await click(frames()[0] ?? null);
    await decode(sizes);
    await press("ArrowRight");
    await press("ArrowRight");

    expect(lightboxText()).toContain("Sizes differ");
    expect(lightboxText()).toContain("3104×2024 against 1552×1012");
    const toggle = document.querySelector<HTMLInputElement>(
      ".image-lightbox__toggle input"
    );
    expect(toggle?.checked).toBe(true);
  });
});

describe("DiffViewer image copy menu", () => {
  const menuLabels = (): string[] =>
    Array.from(document.querySelectorAll(".pop-menu button")).map(
      (item) => item.textContent ?? ""
    );

  async function rightClick(node: Element | null): Promise<void> {
    await act(async () => {
      node?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
  }

  it("offers each revision and the composed strips from the row", async () => {
    dispatchMock.mockImplementation(async (name: string) =>
      name === "diff:image" ? anyImage() : ok(null)
    );
    await act(async () => {
      root.render(
        <DiffViewer
          patch={modifiedBinaryPatch("art/logo.png")}
          images={REVISIONS}
        />
      );
    });
    await decodeAll({ w: 64, h: 64 });
    await rightClick(container.querySelector(".diff-image"));

    expect(menuLabels()).toEqual([
      "Copy before",
      "Copy after",
      "Copy diff",
      "Copy before + after",
      "Copy before + after + diff"
    ]);
  });

  it("offers only what an added file has", async () => {
    dispatchMock.mockImplementation(async (name: string) =>
      name === "diff:image" ? anyImage() : ok(null)
    );
    await act(async () => {
      root.render(
        <DiffViewer patch={binaryPatch("art/added.png")} images={REVISIONS} />
      );
    });
    await decodeAll({ w: 64, h: 64 });
    await rightClick(container.querySelector(".diff-image"));

    // Nothing to compare against, so no diff and no strips.
    expect(menuLabels()).toEqual(["Copy after"]);
  });

  it("gives Escape to the open menu, not to the viewer behind it", async () => {
    await openLightbox(modifiedBinaryPatch("art/logo.png"));
    await rightClick(document.querySelector(".image-lightbox__stage"));
    expect(menuLabels().length).toBeGreaterThan(0);

    // The lightbox registered its keydown first, so without the guard it
    // answers Escape before the menu does and takes the whole viewer — and
    // with it the zoom, the pan, and the place in the walk.
    const event = await press("Escape");
    expect(lightbox()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("offers the same menu from inside the lightbox", async () => {
    await openLightbox(modifiedBinaryPatch("art/logo.png"));
    await rightClick(document.querySelector(".image-lightbox__stage"));

    expect(menuLabels()).toContain("Copy before + after + diff");
  });
});
