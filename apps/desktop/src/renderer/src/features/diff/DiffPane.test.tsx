// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type PartialFileDiff } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  showErrorToast: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));
vi.mock("../../lib/toast", () => ({ showErrorToast: mocks.showErrorToast }));
// The image side fetches its own blobs and has its own suite.
vi.mock("./ImageDiff", () => ({ ImageDiff: () => null }));

import { DiffPane } from "./DiffPane";

const patch = [
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

const snapshot = (fingerprint: string): PartialFileDiff => ({
  path: "file.txt",
  staged: false,
  patch,
  fingerprint,
  capability: { available: true },
  hunks: [
    {
      id: "h:0:2:2",
      header: "@@ -2 +2 @@",
      lineSelection: true,
      lines: [
        {
          id: "h:0:2:2:d:2",
          kind: "delete",
          oldLine: 2,
          newLine: null,
          text: "old"
        },
        {
          id: "h:0:2:2:a:2",
          kind: "add",
          oldLine: null,
          newLine: 2,
          text: "new"
        }
      ]
    }
  ],
  counterpartChanges: false
});

describe("DiffPane refreshing an open working-tree diff", () => {
  let container: HTMLDivElement;
  let root: Root;
  /** Event channel → the pane's handler. */
  let handlers: Map<string, (payload: { worktreeId: string }) => void>;
  let current: PartialFileDiff;

  const tick = (): HTMLInputElement => {
    const box = container.querySelector<HTMLInputElement>(
      '.diff-row.is-tickable input[type="checkbox"]'
    );
    if (box === null) throw new Error("no tickable row rendered");
    return box;
  };
  const gutterOf = (box: HTMLInputElement): HTMLElement =>
    box.closest(".diff-row")!.querySelector(".diff-gutter") as HTMLElement;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    current = snapshot("fingerprint-1");
    handlers = new Map();
    mocks.subscribe.mockImplementation(
      (channel: string, handler: (p: { worktreeId: string }) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      }
    );
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "diff:fileSelection" ? ok(current) : ok(null)
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <DiffPane
          worktreeId="worktree-1"
          target={{ kind: "file", path: "file.txt", staged: false }}
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const announce = async (): Promise<void> => {
    await act(async () => {
      handlers.get("changes:changed")?.({ worktreeId: "worktree-1" });
    });
  };

  it("keeps the ticks and the rendered body when the file's diff is unchanged", async () => {
    await act(async () => gutterOf(tick()).click());
    expect(tick().checked).toBe(true);

    // The watcher behind this event fingerprints the whole worktree, so it
    // fires for edits to files this pane is not showing. Nothing about this
    // file moved, so nothing the reader chose may move either.
    await announce();

    expect(tick().checked).toBe(true);
    expect(container.querySelector(".diff-selection-bar__count")?.textContent)
      .toBe("1 selected");
    // No teardown: the body never falls back to the loading placeholder, which
    // is what used to reset the reader's scroll position.
    expect(container.querySelector(".diff-empty")).toBeNull();
    expect(container.querySelector(".diff-stale-notice")).toBeNull();
  });

  it("extends a tick through shift-click into a fully ticked range", async () => {
    // The composed regression: DiffViewer decides the gesture, DiffPane owns
    // the set. The old contract encoded intent in array order and this exact
    // sequence — tick a line, shift-click to extend — cleared the range
    // instead of ticking it. Every prior test stopped at one component.
    const boxes = (): HTMLInputElement[] => [
      ...container.querySelectorAll<HTMLInputElement>(
        '.diff-row.is-tickable input[type="checkbox"]'
      )
    ];
    expect(boxes()).toHaveLength(2);

    await act(async () => gutterOf(boxes()[0]!).click());
    expect(boxes()[0]?.checked).toBe(true);

    await act(async () =>
      gutterOf(boxes()[1]!).dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true })
      )
    );
    expect(boxes().map((box) => box.checked)).toEqual([true, true]);
    expect(container.querySelector(".diff-selection-bar__count")?.textContent)
      .toBe("2 selected");
  });

  it("drops the ticks and says why once the file's diff really moves", async () => {
    await act(async () => gutterOf(tick()).click());
    expect(tick().checked).toBe(true);

    // Positional line IDs describe a different edit against a new snapshot,
    // so carrying the ticks over would stage a line the reader never picked.
    current = snapshot("fingerprint-2");
    await announce();

    expect(tick().checked).toBe(false);
    expect(container.querySelector(".diff-stale-notice")?.textContent).toContain(
      "This file changed"
    );
    // Ticking again clears the notice rather than leaving it to linger.
    await act(async () => gutterOf(tick()).click());
    expect(container.querySelector(".diff-stale-notice")).toBeNull();
  });

  it("applies against the fingerprint the ticks were chosen on", async () => {
    await act(async () => gutterOf(tick()).click());
    const apply = container.querySelector<HTMLButtonElement>(
      ".diff-selection-bar__apply"
    );
    expect(apply?.textContent).toBe("Stage 1 line");
    await act(async () => apply?.click());

    expect(mocks.dispatch).toHaveBeenCalledWith("changes:applySelection", {
      worktreeId: "worktree-1",
      path: "file.txt",
      staged: false,
      fingerprint: "fingerprint-1",
      lineIds: ["h:0:2:2:d:2"]
    });
  });

  it("stages the whole file from the pane", async () => {
    const file = container.querySelector<HTMLButtonElement>(
      ".diff-selection-bar__file"
    );
    expect(file?.textContent).toBe("Stage file");
    await act(async () => file?.click());

    expect(mocks.dispatch).toHaveBeenCalledWith("changes:stage", {
      worktreeId: "worktree-1",
      paths: ["file.txt"]
    });
  });

  it("teaches the gesture hint once, then yields the bar to the ? button", async () => {
    expect(container.querySelector(".diff-selection-bar__hint")).not.toBeNull();
    expect(container.querySelector(".diff-selection-bar__help")).not.toBeNull();

    // The first landed selection is proof the gesture is learned.
    await act(async () => gutterOf(tick()).click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".diff-selection-bar__apply")
        ?.click()
    );
    expect(container.querySelector(".diff-selection-bar__hint")).toBeNull();
    expect(window.localStorage.getItem("pwrgit.diffHintSeen")).toBe("1");

    // And it stays retired on the next mount.
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <DiffPane
          worktreeId="worktree-1"
          target={{ kind: "file", path: "file.txt", staged: false }}
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });
    expect(container.querySelector(".diff-selection-bar__hint")).toBeNull();
  });

  it("opens the gestures card from ? and closes it with Escape, keeping the pane", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <DiffPane
          worktreeId="worktree-1"
          target={{ kind: "file", path: "file.txt", staged: false }}
          onOpenFile={vi.fn()}
          onClose={onClose}
        />
      );
    });

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".diff-selection-bar__help")
        ?.click()
    );
    const card = container.querySelector(".diff-help");
    expect(card).not.toBeNull();
    // Only wired bindings are advertised — no key the pane would ignore.
    expect(card?.textContent).toContain("next / previous hunk");
    expect(card?.textContent).not.toContain("space");

    // Escape claims the card first; the pane stays open.
    await act(async () => {
      container
        .querySelector<HTMLElement>(".diff-pane")
        ?.dispatchEvent(
          // cancelable, as real key events are — the card claims Escape
          // via preventDefault and the pane's window listener honors it.
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true
          })
        );
    });
    expect(container.querySelector(".diff-help")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers the way across once this side is settled", async () => {
    const onOpenFile = vi.fn();
    current = {
      ...snapshot("fingerprint-3"),
      patch: "",
      hunks: [],
      capability: {
        available: false,
        reason: "no_changes",
        message: "There are no textual hunks to select."
      },
      counterpartChanges: true
    };
    await act(async () => {
      root.render(
        <DiffPane
          worktreeId="worktree-1"
          target={{ kind: "file", path: "file.txt", staged: false }}
          onOpenFile={onOpenFile}
          onClose={vi.fn()}
        />
      );
    });
    await announce();

    const bar = container.querySelector(".diff-selection-bar--settled");
    expect(bar?.textContent).toContain("Nothing to stage here.");
    expect(bar?.textContent).toContain("Every change to this file is staged.");
    expect(container.textContent).not.toContain("Whole file only");

    // Outline, not solid: solid accent is reserved for actions that write to
    // the index, and this one only navigates.
    expect(bar?.querySelector(".diff-selection-bar__apply")).toBeNull();
    const across = bar?.querySelector<HTMLButtonElement>(
      ".diff-selection-bar__file"
    );
    expect(across?.textContent).toBe("View staged changes");
    await act(async () => across?.click());
    expect(onOpenFile).toHaveBeenCalledWith("file.txt", true);
  });
});
