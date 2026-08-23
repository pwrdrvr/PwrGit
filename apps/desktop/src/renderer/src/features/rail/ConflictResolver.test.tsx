// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type ConflictInspection,
  type ConflictState,
  type Result
} from "@pwrgit/shared";

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

  const editWorkingFile = async (text: string): Promise<void> => {
    const editor = container.querySelector("textarea");
    if (editor === null) throw new Error("working-file editor not found");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter?.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
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

  it("blocks staging until an inline draft has been saved", async () => {
    const editor = container.querySelector("textarea");
    expect(editor).not.toBeNull();
    await editWorkingFile("resolved draft\n");

    expect(button("Stage current resolution").disabled).toBe(true);
    await act(async () => button("Stage current resolution").click());
    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      "conflict:stage",
      expect.anything()
    );

    await act(async () => button("Save working file").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("conflict:writeWorkingFile", {
      worktreeId: "worktree-1",
      path: "src/conflicted file.txt",
      text: "resolved draft\n",
      expectedContentHash: "working-hash"
    });
    await vi.waitFor(() =>
      expect(button("Stage current resolution").disabled).toBe(false)
    );

    await act(async () => button("Stage current resolution").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("conflict:stage", {
      worktreeId: "worktree-1",
      path: "src/conflicted file.txt"
    });
  });

  it("re-inspects changed stages before enabling acceptance", async () => {
    const updatedState: ConflictState = {
      ...state,
      conflicts: [
        {
          ...state.conflicts[0],
          ours: { stage: 2, oid: "ours-new", mode: "100644" }
        }
      ]
    };
    const updatedInspection: ConflictInspection = {
      ...inspection,
      ours: {
        ...inspection.ours!,
        oid: "ours-new",
        content: { kind: "text", text: "new ours\n" }
      }
    };
    let resolveInspection!: (result: Result<ConflictInspection>) => void;
    const pendingInspection = new Promise<Result<ConflictInspection>>(
      (resolve) => {
        resolveInspection = resolve;
      }
    );
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "conflict:inspect") return pendingInspection;
      return ok(null);
    });

    await act(async () => {
      root.render(
        <ConflictResolver
          worktreeId="worktree-1"
          state={updatedState}
          onRefresh={onRefresh}
        />
      );
    });
    expect(button("Accept ours").disabled).toBe(true);

    await act(async () => resolveInspection(ok(updatedInspection)));
    await vi.waitFor(() => expect(button("Accept ours").disabled).toBe(false));
    await act(async () => button("Accept ours").click());

    expect(mocks.dispatch).toHaveBeenCalledWith("conflict:accept", {
      worktreeId: "worktree-1",
      path: "src/conflicted file.txt",
      side: "ours",
      expectedOid: "ours-new"
    });
  });

  it("preserves a CRLF working file when saving an inline edit", async () => {
    const crlfInspection: ConflictInspection = {
      ...inspection,
      ours: { ...inspection.ours!, oid: "ours-crlf" },
      workingTree: {
        ...inspection.workingTree!,
        contentHash: "crlf-hash",
        content: { kind: "text", text: "first\r\nsecond\r\n" }
      }
    };
    const crlfState: ConflictState = {
      ...state,
      conflicts: [
        {
          ...state.conflicts[0],
          ours: { stage: 2, oid: "ours-crlf", mode: "100644" }
        }
      ]
    };
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "conflict:inspect" ? ok(crlfInspection) : ok(null)
    );
    await act(async () => {
      root.render(
        <ConflictResolver
          worktreeId="worktree-1"
          state={crlfState}
          onRefresh={onRefresh}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector("textarea")?.value).toBe("first\nsecond\n")
    );

    await editWorkingFile("first\nchanged\n");
    await act(async () => button("Save working file").click());

    expect(mocks.dispatch).toHaveBeenCalledWith("conflict:writeWorkingFile", {
      worktreeId: "worktree-1",
      path: "src/conflicted file.txt",
      text: "first\r\nchanged\r\n",
      expectedContentHash: "crlf-hash"
    });
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
