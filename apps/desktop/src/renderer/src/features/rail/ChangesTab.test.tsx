import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ChangeSet } from "@pwrgit/shared";
import { confirmAndDiscardAllChanges } from "./ChangesTab";

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));
vi.mock("../shell/dialogs", () => ({ confirmDialog: mocks.confirmDialog }));

const changes: ChangeSet = {
  staged: [
    { path: "both.txt", status: "M", staged: true },
    { path: "staged add.txt", status: "A", staged: true }
  ],
  unstaged: [
    { path: "both.txt", status: "M", staged: false },
    { path: "new folder/file.txt", status: "?", staged: false }
  ]
};

describe("ChangesTab discard all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.dispatch.mockResolvedValue(ok(null));
  });

  it("confirms the unique file count and sends one bulk IPC command", async () => {
    await confirmAndDiscardAllChanges("worktree-1", changes);

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Discard all changes?",
        message: expect.stringContaining("across 3 files")
      })
    );
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      "changes:discardAll",
      { worktreeId: "worktree-1" }
    );
  });
});
