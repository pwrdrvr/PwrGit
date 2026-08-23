// @vitest-environment jsdom

import { act } from "react";
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
const COMMITTED_AT = "2025-06-01T12:00:00.000Z";

let container: HTMLDivElement;
let root: Root;

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

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
  it("renders rename-aware history, blame ranges, identity, and lineage navigation", async () => {
    dispatchMock.mockImplementation((name: string) => {
      if (name === "file:history") {
        return Promise.resolve(
          ok({
            entries: [
              {
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
                status: "R"
              }
            ],
            nextCursor: null
          })
        );
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
            hunks: [
              {
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
                uncommitted: false
              }
            ]
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
    expect(container.textContent).toContain(
      "legacy/guide.txt → docs/guide.txt"
    );
    expect(container.textContent).toContain("@ada");
    const historyCommit = container.querySelector<HTMLButtonElement>(
      '.file-history [aria-label^="Show commit"]'
    );
    await act(async () => historyCommit?.click());
    expect(showCommit).toHaveBeenCalledWith(HASH_A, "move guide into docs");

    const blameTab = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")]
      .find((button) => button.textContent === "Blame");
    await act(async () => blameTab?.click());
    await settle();

    expect(container.textContent).toContain("deleted in the selected commit");
    expect(container.textContent).toContain("L2–3");
    expect(container.textContent).toContain("shared, clarified");
    expect(container.textContent).toContain("from legacy/guide.txt");
    expect(container.textContent).toContain("@grace");
    const blameCommit = container.querySelector<HTMLButtonElement>(
      '.file-blame [aria-label^="Show commit"]'
    );
    await act(async () => blameCommit?.click());
    expect(showCommit).toHaveBeenLastCalledWith(HASH_B, "clarify the guide");
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
    const historyTab = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")]
      .find((button) => button.textContent === "History");
    await act(async () => historyTab?.click());
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
              {
                hash: HASH_A,
                shortHash: HASH_A.slice(0, 7),
                parents: [],
                subject: "old file change",
                authorName: "Ada Lovelace",
                authorEmail: "ada@example.test",
                committedAt: COMMITTED_AT,
                isMerge: false,
                path: "docs/guide.txt",
                status: "A"
              }
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

    const commit = container.querySelector<HTMLButtonElement>(
      '.file-history [aria-label^="Show commit"]'
    );
    await act(async () => commit?.click());

    expect(container.querySelector("[data-testid=file-history]")).not.toBeNull();
    expect(container.textContent).toContain(
      "older than the loaded lineage window"
    );
  });
});
