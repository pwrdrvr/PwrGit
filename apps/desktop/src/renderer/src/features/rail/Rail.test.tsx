// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type ConflictState,
  type Result,
  type Worktree
} from "@pwrgit/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  confirmDialog: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));
vi.mock("../shell/dialogs", () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: mocks.showErrorToast,
  showInfoToast: mocks.showInfoToast
}));

import { Rail } from "./Rail";

const unresolved: ConflictState = {
  operation: { kind: "merge", label: "Merge" },
  conflicts: [
    {
      path: "conflict.txt",
      kind: "both_modified",
      base: { stage: 1, oid: "base", mode: "100644" },
      ours: { stage: 2, oid: "ours", mode: "100644" },
      theirs: { stage: 3, oid: "theirs", mode: "100644" },
      workingTree: { kind: "file", size: 20 }
    }
  ]
};

describe("Rail conflict refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentState: ConflictState;
  let handlers: Map<
    string,
    Set<(event: { worktreeId: string }) => void>
  >;

  const renderRail = async (worktreeId: string): Promise<void> => {
    await act(async () => {
      root.render(
        <Rail
          worktree={{ id: worktreeId, dirty: 1 } as Worktree}
          state={null}
          activeEmail="test@pwrgit.dev"
          selectedHashes={[]}
          rebaseAction={null}
          commitFocus={null}
          onCloseCommit={vi.fn()}
          onOpenCommitFile={vi.fn()}
          onOpenFullCommitDiff={vi.fn()}
          onClearSelection={vi.fn()}
          onCollapse={vi.fn()}
          onOpenDiff={vi.fn()}
        />
      );
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    currentState = unresolved;
    handlers = new Map();
    mocks.subscribe.mockImplementation(
      (channel: string, handler: (event: { worktreeId: string }) => void) => {
        const listeners = handlers.get(channel) ?? new Set();
        listeners.add(handler);
        handlers.set(channel, listeners);
        return () => listeners.delete(handler);
      }
    );
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "conflict:state") return ok(currentState);
      if (command === "conflict:inspect") {
        return ok({
          ...unresolved.conflicts[0],
          base: null,
          ours: null,
          theirs: null,
          workingTree: null
        });
      }
      return ok(null);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await renderRail("worktree-1");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("re-reads operation state when an external resolution moves the index", async () => {
    expect(container.textContent).toContain("1 unresolved path");
    expect(container.textContent).toContain("Resolve");
    expect(container.textContent).not.toContain("Rebase");

    currentState = { operation: unresolved.operation, conflicts: [] };
    expect(handlers.get("changes:changed")?.size).toBeGreaterThan(0);
    const beforeRefreshCalls = mocks.dispatch.mock.calls.filter(
      (call) => call[0] === "conflict:state"
    ).length;
    await act(async () => {
      for (const handler of handlers.get("changes:changed") ?? []) {
        handler({ worktreeId: "worktree-1" });
      }
    });
    expect(
      mocks.dispatch.mock.calls.filter((call) => call[0] === "conflict:state")
        .length
    ).toBe(beforeRefreshCalls + 1);

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Ready to continue")
    );
    expect(container.textContent).toContain("Continue merge");
  });

  it("ignores external changes from another worktree", async () => {
    const callsBefore = mocks.dispatch.mock.calls.filter(
      (call) => call[0] === "conflict:state"
    ).length;
    currentState = { operation: unresolved.operation, conflicts: [] };

    await act(async () => {
      for (const handler of handlers.get("changes:changed") ?? []) {
        handler({ worktreeId: "worktree-2" });
      }
    });

    const callsAfter = mocks.dispatch.mock.calls.filter(
      (call) => call[0] === "conflict:state"
    ).length;
    expect(callsAfter).toBe(callsBefore);
    expect(container.textContent).toContain("1 unresolved path");
  });

  it("discards a refresh that completes after switching worktrees", async () => {
    const worktreeB: ConflictState = {
      operation: { kind: "merge", label: "Merge" },
      conflicts: [
        {
          ...unresolved.conflicts[0],
          path: "worktree-b.txt"
        }
      ]
    };
    let resolveOldRefresh!: (result: Result<ConflictState>) => void;
    const oldRefresh = new Promise<Result<ConflictState>>((resolve) => {
      resolveOldRefresh = resolve;
    });
    mocks.dispatch.mockImplementation(
      async (command: string, input: { worktreeId?: string }) => {
        if (command === "conflict:state") {
          return input.worktreeId === "worktree-1"
            ? oldRefresh
            : ok(worktreeB);
        }
        if (command === "conflict:inspect") {
          return ok({
            ...worktreeB.conflicts[0],
            base: null,
            ours: null,
            theirs: null,
            workingTree: null
          });
        }
        return ok(null);
      }
    );

    const refresh = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Refresh"
    );
    if (refresh === undefined) throw new Error("refresh button not found");
    await act(async () => {
      refresh.click();
      await Promise.resolve();
    });
    await renderRail("worktree-2");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("worktree-b.txt")
    );

    await act(async () => resolveOldRefresh(ok(unresolved)));
    expect(container.textContent).toContain("worktree-b.txt");
    expect(container.textContent).not.toContain("conflict.txt");
  });
});
