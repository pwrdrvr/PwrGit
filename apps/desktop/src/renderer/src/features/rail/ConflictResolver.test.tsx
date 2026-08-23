// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ConflictInspection, type ConflictState } from "@pwrgit/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  dispatch: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../shell/dialogs", () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: mocks.showErrorToast,
  showInfoToast: mocks.showInfoToast
}));

import { ConflictResolver } from "./ConflictResolver";

const state: ConflictState = {
  operation: { kind: "merge", label: "Merge" },
  conflicts: [
    {
      path: "src/conflicted file.txt",
      kind: "delete_or_rename_by_theirs",
      base: { stage: 1, oid: "base", mode: "100644" },
      ours: { stage: 2, oid: "ours", mode: "100644" },
      theirs: null,
      workingTree: { kind: "file", size: 12 }
    }
  ]
};

const inspection: ConflictInspection = {
  path: "src/conflicted file.txt",
  kind: "delete_or_rename_by_theirs",
  base: {
    stage: 1,
    oid: "base",
    mode: "100644",
    size: 5,
    content: { kind: "text", text: "base\n" }
  },
  ours: {
    stage: 2,
    oid: "ours",
    mode: "100644",
    size: 5,
    content: { kind: "text", text: "ours\n" }
  },
  theirs: null,
  workingTree: {
    kind: "file",
    size: 12,
    contentHash: "working-hash",
    editable: true,
    content: { kind: "text", text: "markers\n" }
  }
};

describe("ConflictResolver", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRefresh = vi.fn(async () => undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "conflict:inspect" ? ok(inspection) : ok(null)
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ConflictResolver
          worktreeId="worktree-1"
          state={state}
          onRefresh={onRefresh}
        />
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const button = (text: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === text
    );
    if (found === undefined) throw new Error(`button not found: ${text}`);
    return found;
  };

  it("shows missing stages honestly and guards an accepted deletion", async () => {
    expect(container.textContent).toContain("modify/delete or rename-related");
    expect(container.textContent).toContain("Theirs · missing");

    await act(async () => button("Accept theirs (delete)").click());

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Accept theirs for this path?",
        danger: true,
        message: expect.stringContaining("delete and stage this path")
      })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith("conflict:accept", {
      worktreeId: "worktree-1",
      path: "src/conflicted file.txt",
      side: "theirs",
      expectedOid: null
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("keeps save separate from staging a manual resolution", async () => {
    const editor = container.querySelector("textarea");
    expect(editor).not.toBeNull();

    await act(async () => button("Stage current resolution").click());

    expect(mocks.dispatch).toHaveBeenCalledWith("conflict:stage", {
      worktreeId: "worktree-1",
      path: "src/conflicted file.txt"
    });
    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      "conflict:writeWorkingFile",
      expect.anything()
    );
  });

  it("requires confirmation before continuing the exact operation", async () => {
    await act(async () => {
      root.render(
        <ConflictResolver
          worktreeId="worktree-1"
          state={{ operation: state.operation, conflicts: [] }}
          onRefresh={onRefresh}
        />
      );
    });

    await act(async () => button("Continue merge…").click());

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Continue merge?",
        message: expect.stringContaining("git merge --continue")
      })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith("conflict:continue", {
      worktreeId: "worktree-1",
      operation: "merge"
    });
  });
});
