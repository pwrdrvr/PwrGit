// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const dispatchMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn(() => () => undefined));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: subscribeMock
}));

import { FileInsightsPane } from "./FileInsightsPane";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const COMMITTED_AT = "2025-06-01T12:00:00.000Z";

let container: HTMLDivElement;
let root: Root;

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Escape is handled on a deferred tick, exactly as DiffPane does it. */
const pressEscape = async (): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const tabButton = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
    (button) => button.textContent === label
  );

const historyEntry = (overrides: Record<string, unknown> = {}) => ({
  hash: HASH_A,
  shortHash: HASH_A.slice(0, 7),
  parents: [HASH_B],
  subject: "move guide into docs",
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.test",
  committedAt: COMMITTED_AT,
  isMerge: false,
  path: "docs/guide.txt",
  previousPath: "legacy/guide.txt",
  status: "R",
  ...overrides
});

const blameHunk = (overrides: Record<string, unknown> = {}) => ({
  hash: HASH_B,
  shortHash: HASH_B.slice(0, 7),
  authorName: "Grace Hopper",
  authorEmail: "grace@example.test",
  committedAt: COMMITTED_AT,
  subject: "clarify the guide",
  sourcePath: "legacy/guide.txt",
  originalStartLine: 1,
  startLine: 2,
  endLine: 3,
  lines: ["shared, clarified", "new line"],
  uncommitted: false,
  ...overrides
});

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

describe("FileInsightsPane", () => {
  it("renders rename-aware history, blame lines, identity, and lineage navigation", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }));
      }
      if (name === "file:blame") {
        return Promise.resolve(
          ok({
            path: "docs/guide.txt",
            effectiveContext: { kind: "commit", hash: HASH_B },
            notice:
              "This file is deleted in the selected commit. Showing its parent revision.",
            bytes: 22,
            nextCursor: null,
            hunks: [blameHunk()]
          })
        );
      }
      if (name === "github:hydrateCommitAuthorIdentities") {
        return Promise.resolve(
          ok({
            [HASH_A]: {
              cacheState: "fresh",
              refreshState: "idle",
              identity: { login: "ada" }
            },
            [HASH_B]: {
              cacheState: "fresh",
              refreshState: "idle",
              identity: { login: "grace" }
            }
          })
        );
      }
      return Promise.resolve(ok(null));
    });
    const showCommit = vi.fn(() => true);

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "commit", hash: HASH_A }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={showCommit}
        />
      );
    });
    await settle();

    expect(container.textContent).toContain("move guide into docs");
    expect(container.textContent).toContain("legacy/guide.txt → docs/guide.txt");
    expect(container.textContent).toContain("@ada");
    // The status chip carries a name, not just a letter.
    expect(
      container.querySelector('.file-status[aria-label="Renamed"]')
    ).not.toBeNull();

    const lineage = container.querySelector<HTMLButtonElement>(
      '.file-history [aria-label^="Show commit"]'
    );
    await act(async () => lineage?.click());
    expect(showCommit).toHaveBeenCalledWith(HASH_A, "move guide into docs");

    await act(async () => tabButton("Blame")?.click());
    await settle();

    expect(container.textContent).toContain("deleted in the selected commit");
    expect(container.textContent).toContain("shared, clarified");
    expect(container.textContent).toContain("from legacy/guide.txt");
    expect(container.textContent).toContain("@grace");
    // One line per row, numbered from the hunk's absolute start.
    expect(
      [...container.querySelectorAll(".file-blame__number")].map(
        (node) => node.textContent
      )
    ).toEqual(["2", "3"]);
    // One scroller for the file, not one per hunk.
    expect(container.querySelectorAll(".file-blame__lines")).toHaveLength(1);

    const blameLineage = container.querySelector<HTMLButtonElement>(
      '.file-blame [aria-label^="Show commit"]'
    );
    await act(async () => blameLineage?.click());
    expect(showCommit).toHaveBeenLastCalledWith(HASH_B, "clarify the guide");
  });

  it("opens a commit's diff for the file without losing the history list", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }));
      }
      if (name === "diff:commitFile") {
        return Promise.resolve(
          ok(
            [
              "diff --git a/docs/guide.txt b/docs/guide.txt",
              "--- a/docs/guide.txt",
              "+++ b/docs/guide.txt",
              "@@ -1 +1 @@",
              "-shared",
              "+shared, clarified"
            ].join("\n")
          )
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    const open = container.querySelector<HTMLButtonElement>(".file-history__open");
    // The row is a button, so its aria-label replaces the status chip inside
    // it — the change kind has to be part of this name or it is never heard.
    expect(open?.getAttribute("aria-label")).toBe(
      `Renamed: show what ${HASH_A.slice(0, 7)} changed in docs/guide.txt`
    );
    await act(async () => open?.click());
    await settle();

    expect(dispatchMock).toHaveBeenCalledWith("diff:commitFile", {
      worktreeId: "wt-1",
      hash: HASH_A,
      path: "docs/guide.txt"
    });
    expect(container.querySelector("[data-testid=file-insight-diff]")).not.toBeNull();
    expect(container.textContent).toContain("shared, clarified");

    // Picking a tab means "show me that": the commit diff gets out of the way
    // rather than leaving the tab looking dead.
    await act(async () => tabButton("History")?.click());
    await settle();
    expect(container.querySelector("[data-testid=file-insight-diff]")).toBeNull();

    await act(async () => open?.click());
    await settle();
    expect(container.querySelector("[data-testid=file-insight-diff]")).not.toBeNull();

    // Escape pops the diff and puts the list back with no second Git read.
    const historyReads = dispatchMock.mock.calls.filter(
      ([name]) => name === "file:history"
    ).length;
    await pressEscape();
    await settle();
    expect(container.querySelector("[data-testid=file-insight-diff]")).toBeNull();
    expect(container.querySelector("[data-testid=file-history]")).not.toBeNull();
    expect(
      dispatchMock.mock.calls.filter(([name]) => name === "file:history")
    ).toHaveLength(historyReads);
  });

  it("closes the pane when Escape is pressed at the base level", async () => {
    dispatchMock.mockImplementation((name: string) =>
      name === "file:history"
        ? Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }))
        : Promise.resolve(ok({}))
    );
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={onClose}
          onShowCommit={() => true}
        />
      );
    });
    await settle();
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("blames the file before a commit and unwinds the drill-down", async () => {
    let blameCalls = 0;
    dispatchMock.mockImplementation((name: string, req: Record<string, unknown>) => {
      if (name === "file:blame") {
        blameCalls += 1;
        const drilled =
          (req["context"] as { kind: string; hash?: string }).hash === HASH_C;
        return Promise.resolve(
          ok({
            path: "legacy/guide.txt",
            effectiveContext: req["context"],
            hunks: [
              blameHunk({
                startLine: 1,
                endLine: 1,
                lines: [drilled ? "shared" : "shared, clarified"],
                sourcePath: "legacy/guide.txt"
              })
            ],
            nextCursor: null,
            bytes: 12
          })
        );
      }
      if (name === "commit:lookup") {
        return Promise.resolve(
          ok({
            hash: HASH_B,
            shortHash: HASH_B.slice(0, 7),
            parents: [HASH_C],
            subject: "clarify the guide",
            authorName: "Grace Hopper",
            authorEmail: "grace@example.test",
            committedAt: COMMITTED_AT,
            isMerge: false
          })
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="legacy/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="blame"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();
    expect(blameCalls).toBe(1);

    const before = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Blame legacy/guide.txt before"]'
    );
    expect(before).not.toBeNull();
    await act(async () => before?.click());
    await settle();

    expect(blameCalls).toBe(2);
    const drilled = dispatchMock.mock.calls.filter(
      ([name]) => name === "file:blame"
    );
    expect(drilled[1]?.[1]).toMatchObject({
      path: "legacy/guide.txt",
      context: { kind: "commit", hash: HASH_C }
    });
    expect(container.textContent).toContain(`before ${HASH_B.slice(0, 7)}`);
    expect(container.textContent).toContain(`Commit ${HASH_C.slice(0, 7)}`);

    // Escape unwinds one level rather than closing the pane outright.
    await pressEscape();
    await settle();
    expect(container.textContent).not.toContain(`before ${HASH_B.slice(0, 7)}`);
  });

  it("says so when a line's commit has no parent to blame before", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:blame") {
        return Promise.resolve(
          ok({
            path: "docs/guide.txt",
            effectiveContext: { kind: "workingTree" },
            hunks: [blameHunk({ startLine: 1, endLine: 1, lines: ["alpha"] })],
            nextCursor: null,
            bytes: 6
          })
        );
      }
      if (name === "commit:lookup") {
        return Promise.resolve(
          ok({
            hash: HASH_B,
            shortHash: HASH_B.slice(0, 7),
            parents: [],
            subject: "root",
            authorName: "Grace Hopper",
            authorEmail: "grace@example.test",
            committedAt: COMMITTED_AT,
            isMerge: false
          })
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="blame"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    const before = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Blame legacy/guide.txt before"]'
    );
    await act(async () => before?.click());
    await settle();
    expect(container.textContent).toContain("has no parent commit");
  });

  it("keeps both panels mounted so switching tabs re-runs no Git read", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }));
      }
      if (name === "file:blame") {
        return Promise.resolve(
          ok({
            path: "docs/guide.txt",
            effectiveContext: { kind: "workingTree" },
            hunks: [blameHunk({ startLine: 1, endLine: 1, lines: ["alpha"] })],
            nextCursor: null,
            bytes: 6
          })
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();
    // Blame has not been asked for yet, so it has not been read.
    expect(
      dispatchMock.mock.calls.filter(([name]) => name === "file:blame")
    ).toHaveLength(0);

    await act(async () => tabButton("Blame")?.click());
    await settle();
    await act(async () => tabButton("History")?.click());
    await settle();
    await act(async () => tabButton("Blame")?.click());
    await settle();

    expect(
      dispatchMock.mock.calls.filter(([name]) => name === "file:history")
    ).toHaveLength(1);
    expect(
      dispatchMock.mock.calls.filter(([name]) => name === "file:blame")
    ).toHaveLength(1);
  });

  it("wires the tablist for keyboards and screen readers", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }));
      }
      if (name === "file:blame") {
        return Promise.resolve(
          ok({
            path: "docs/guide.txt",
            effectiveContext: { kind: "workingTree" },
            hunks: [],
            nextCursor: null,
            bytes: 0
          })
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    const history = tabButton("History");
    const blame = tabButton("Blame");
    const panel = container.querySelector("[role=tabpanel]");
    expect(history?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(history?.id);
    // Roving tab stop: the tablist is one Tab stop.
    expect(history?.tabIndex).toBe(0);
    expect(blame?.tabIndex).toBe(-1);

    await act(async () => {
      history?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true
        })
      );
    });
    await settle();
    expect(tabButton("Blame")?.getAttribute("aria-selected")).toBe("true");
    expect(tabButton("History")?.getAttribute("aria-selected")).toBe("false");
  });

  it("pages in the next block when the load control scrolls into view", async () => {
    // jsdom has no IntersectionObserver; this one reports the observed node as
    // visible the moment it is watched, which is the case the hook exists for.
    const observers: (() => void)[] = [];
    class ImmediateObserver {
      constructor(private readonly cb: (entries: unknown[]) => void) {}
      observe(): void {
        observers.push(() => this.cb([{ isIntersecting: true }]));
        observers[observers.length - 1]?.();
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal("IntersectionObserver", ImmediateObserver);

    const cursors: (string | undefined)[] = [];
    dispatchMock.mockImplementation(
      (name: string, req: Record<string, unknown>) => {
        if (name !== "file:history") return Promise.resolve(ok({}));
        const cursor = req["cursor"] as string | undefined;
        cursors.push(cursor);
        return Promise.resolve(
          ok({
            entries: [
              historyEntry({ hash: `${cursors.length}`.repeat(40).slice(0, 40) })
            ],
            // Two more pages, then the end — the fill must stop on its own.
            nextCursor: cursors.length < 3 ? `cursor-${cursors.length}` : null
          })
        );
      }
    );

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();
    await settle();

    expect(cursors).toEqual([undefined, "cursor-1", "cursor-2"]);
    // The control is gone once there is nothing left to page.
    expect(container.querySelector(".file-insight__more")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("still loads through the app's StrictMode mount cycle", async () => {
    // main.tsx renders under StrictMode, so in development every effect mounts,
    // cleans up, and mounts again on the SAME instance — refs survive that.
    const settled: (() => void)[] = [];
    dispatchMock.mockImplementation((name: string) => {
      if (name !== "file:history") return Promise.resolve(ok({}));
      return new Promise((resolve) => {
        settled.push(() =>
          resolve(ok({ entries: [historyEntry()], nextCursor: null }))
        );
      });
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <FileInsightsPane
            worktreeId="wt-1"
            path="docs/guide.txt"
            context={{ kind: "workingTree" }}
            initialTab="history"
            onClose={() => undefined}
            onShowCommit={() => true}
          />
        </StrictMode>
      );
    });
    // The throwaway pass is cancelled; a second read has to take its place.
    await act(async () => {
      for (const resolve of settled) resolve();
    });
    await settle();

    expect(container.textContent).not.toContain("Loading file history…");
    expect(container.textContent).toContain("move guide into docs");
  });

  it("still loads blame through the StrictMode mount cycle", async () => {
    const settled: (() => void)[] = [];
    dispatchMock.mockImplementation((name: string) => {
      if (name !== "file:blame") return Promise.resolve(ok({}));
      return new Promise((resolve) => {
        settled.push(() =>
          resolve(
            ok({
              path: "docs/guide.txt",
              effectiveContext: { kind: "workingTree" },
              hunks: [blameHunk({ startLine: 1, endLine: 1, lines: ["alpha"] })],
              nextCursor: null,
              bytes: 6
            })
          )
        );
      });
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <FileInsightsPane
            worktreeId="wt-1"
            path="docs/guide.txt"
            context={{ kind: "workingTree" }}
            initialTab="blame"
            onClose={() => undefined}
            onShowCommit={() => true}
          />
        </StrictMode>
      );
    });
    await act(async () => {
      for (const resolve of settled) resolve();
    });
    await settle();

    expect(container.textContent).not.toContain("Loading blame…");
    expect(container.textContent).toContain("alpha");
  });

  it("recovers when the dispatch itself rejects", async () => {
    // preload hands back `ipcRenderer.invoke` uncaught, so a transport failure
    // REJECTS rather than resolving an err Result. Unhandled, that never
    // released the in-flight guard and the view refused every retry.
    dispatchMock.mockImplementation((name: string) =>
      name === "file:history"
        ? Promise.reject(new Error("ipc transport failure"))
        : Promise.resolve(ok({}))
    );

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    expect(container.textContent).not.toContain("Loading file history…");
    expect(container.textContent).toContain("ipc transport failure");

    // And the guard let go, so Retry actually re-reads.
    dispatchMock.mockImplementation((name: string) =>
      name === "file:history"
        ? Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }))
        : Promise.resolve(ok({}))
    );
    const retry = container.querySelector<HTMLButtonElement>(
      ".file-insight__empty button"
    );
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    await settle();
    expect(container.textContent).toContain("move guide into docs");
  });

  it("recovers when a blame dispatch rejects", async () => {
    dispatchMock.mockImplementation((name: string) =>
      name === "file:blame"
        ? Promise.reject(new Error("ipc transport failure"))
        : Promise.resolve(ok({}))
    );

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="blame"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    expect(container.textContent).not.toContain("Loading blame…");
    expect(container.textContent).toContain("ipc transport failure");
  });

  it("shows the file at the scope's revision on the File tab", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }));
      }
      if (name === "file:contents") {
        return Promise.resolve(
          ok({
            path: "docs/guide.txt",
            effectiveContext: { kind: "commit", hash: HASH_A },
            startLine: 1,
            lines: ["alpha", "shared, clarified"],
            nextCursor: null,
            bytes: 24
          })
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "commit", hash: HASH_A }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    await act(async () => tabButton("File")?.click());
    await settle();

    const contents = container.querySelector("[data-testid=file-contents]");
    expect(contents?.textContent).toContain("shared, clarified");
    expect(
      [...container.querySelectorAll(".file-blame__number")].map(
        (node) => node.textContent
      )
    ).toEqual(["1", "2"]);
  });

  it("drills from a history row to the file as of that commit", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(ok({ entries: [historyEntry()], nextCursor: null }));
      }
      if (name === "file:contents") {
        return Promise.resolve(
          ok({
            path: "docs/guide.txt",
            effectiveContext: { kind: "commit", hash: HASH_A },
            startLine: 1,
            lines: ["alpha"],
            nextCursor: null,
            bytes: 6
          })
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    const view = container.querySelector<HTMLButtonElement>(
      '[aria-label^="View docs/guide.txt as of"]'
    );
    expect(view).not.toBeNull();
    await act(async () => view?.click());
    await settle();

    const call = dispatchMock.mock.calls.find(([name]) => name === "file:contents");
    expect(call?.[1]).toMatchObject({
      path: "docs/guide.txt",
      context: { kind: "commit", hash: HASH_A }
    });
    expect(container.textContent).toContain(`at ${HASH_A.slice(0, 7)}`);
    expect(container.querySelector("[data-testid=file-contents]")).not.toBeNull();
  });

  it("opens blame aimed at the line the reader came from", async () => {
    dispatchMock.mockImplementation((name: string, req: Record<string, unknown>) => {
      if (name !== "file:blame") return Promise.resolve(ok({}));
      const cursor = Number((req["cursor"] as string | undefined) ?? "0");
      return Promise.resolve(
        ok({
          path: "docs/guide.txt",
          effectiveContext: { kind: "workingTree" },
          hunks: [
            blameHunk({
              startLine: cursor + 1,
              endLine: cursor + 200,
              lines: Array.from({ length: 200 }, (_, i) => `line ${cursor + 1 + i}`)
            })
          ],
          nextCursor: null,
          bytes: 4096
        })
      );
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="blame"
          initialLine={250}
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    // Line 250 lives in the second 200-line page, so the read starts there.
    const first = dispatchMock.mock.calls.find(([name]) => name === "file:blame");
    expect(first?.[1]).toMatchObject({ cursor: "200", limit: 200 });
    expect(
      container.querySelector('[data-line="250"]')?.className
    ).toContain("is-target");

    // The lines above are one press away, prepended without touching the tail.
    const earlier = container.querySelector<HTMLButtonElement>(
      ".file-insight__more--earlier"
    );
    expect(earlier).not.toBeNull();
    await act(async () => earlier?.click());
    await settle();
    const calls = dispatchMock.mock.calls.filter(([name]) => name === "file:blame");
    expect(calls[1]?.[1]).toMatchObject({ cursor: "0" });
    expect(container.querySelector('[data-line="1"]')).not.toBeNull();
    expect(container.querySelector(".file-insight__more--earlier")).toBeNull();
  });

  it("lands at the top when the aim overshoots a shorter file", async () => {
    dispatchMock.mockImplementation((name: string, req: Record<string, unknown>) => {
      if (name !== "file:blame") return Promise.resolve(ok({}));
      if (req["cursor"] !== undefined) {
        return Promise.resolve(
          err({ kind: "git", code: "exit_128", message: "file has only 3 lines" })
        );
      }
      return Promise.resolve(
        ok({
          path: "docs/guide.txt",
          effectiveContext: { kind: "workingTree" },
          hunks: [blameHunk({ startLine: 1, endLine: 1, lines: ["alpha"] })],
          nextCursor: null,
          bytes: 6
        })
      );
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="blame"
          initialLine={999}
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();

    // The aimed read failed past EOF; the view fell back to the top on its own
    // instead of stranding the reader on an error for a file that exists.
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("couldn’t be loaded");
  });

  it("shows bounded binary and load-error states", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:blame") {
        return Promise.resolve(
          ok({
            path: "asset.bin",
            effectiveContext: { kind: "workingTree" },
            hunks: [],
            nextCursor: null,
            bytes: 128,
            unavailableReason: "binary"
          })
        );
      }
      return Promise.resolve(ok({}));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="asset.bin"
          context={{ kind: "workingTree" }}
          initialTab="blame"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    await settle();
    expect(container.textContent).toContain(
      "Blame isn’t available for binary files."
    );

    dispatchMock.mockImplementation((name: string) =>
      name === "file:history"
        ? Promise.resolve(
            err({ kind: "git", code: "exit_128", message: "bad revision" })
          )
        : Promise.resolve(ok({}))
    );
    await act(async () => tabButton("History")?.click());
    await settle();
    expect(container.textContent).toContain(
      "File history couldn’t be loaded. bad revision"
    );
    expect(container.querySelector("[role=alert]")).not.toBeNull();
  });

  it("cancels an in-flight Git read when the view closes", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") return new Promise(() => undefined);
      return Promise.resolve(ok(null));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => true}
        />
      );
    });
    const historyRequest = dispatchMock.mock.calls.find(
      ([name]) => name === "file:history"
    );
    expect(historyRequest).toBeDefined();
    const operationId = historyRequest?.[1]?.operationId as string;

    await act(async () => root.unmount());

    expect(dispatchMock).toHaveBeenCalledWith("file:cancelInsight", {
      operationId
    });
    // afterEach owns unmount too; give it a fresh root over the same container.
    root = createRoot(container);
  });

  it("keeps file details open when a commit is outside the lineage window", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(
          ok({
            entries: [
              historyEntry({
                subject: "old file change",
                status: "A",
                previousPath: undefined,
                parents: []
              })
            ],
            nextCursor: null
          })
        );
      }
      if (name === "github:hydrateCommitAuthorIdentities") {
        return Promise.resolve(ok({}));
      }
      return Promise.resolve(ok(null));
    });

    await act(async () => {
      root.render(
        <FileInsightsPane
          worktreeId="wt-1"
          path="docs/guide.txt"
          context={{ kind: "workingTree" }}
          initialTab="history"
          onClose={() => undefined}
          onShowCommit={() => false}
        />
      );
    });
    await settle();

    const lineage = container.querySelector<HTMLButtonElement>(
      '.file-history [aria-label^="Show commit"]'
    );
    await act(async () => lineage?.click());

    expect(container.querySelector("[data-testid=file-history]")).not.toBeNull();
    expect(container.textContent).toContain(
      "older than the loaded lineage window"
    );
  });
});
