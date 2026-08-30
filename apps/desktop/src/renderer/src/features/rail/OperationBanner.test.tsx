// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type OperationState } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  dispatch: vi.fn(),
  subscribe: vi.fn(),
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

import { OperationBanner } from "./OperationBanner";

const rebaseBlocked: OperationState = {
  operation: {
    kind: "rebase",
    label: "Rebase",
    progress: { current: 2, total: 5 }
  },
  conflictCount: 3
};

const rebaseClear: OperationState = {
  operation: {
    kind: "rebase",
    label: "Rebase",
    progress: { current: 2, total: 5 }
  },
  conflictCount: 0
};

describe("OperationBanner", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRefresh = vi.fn();

  const render = async (state: OperationState): Promise<void> => {
    await act(async () => {
      root.render(
        <OperationBanner
          worktreeId="worktree-1"
          state={state}
          onRefresh={onRefresh}
        />
      );
    });
  };

  const button = (text: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(text)
    );
    if (found === undefined) {
      throw new Error(
        `no button containing "${text}"; saw ${[
          ...container.querySelectorAll("button")
        ]
          .map((b) => b.textContent)
          .join(" | ")}`
      );
    }
    return found;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.dispatch.mockResolvedValue(ok({ kind: "completed" }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders nothing when Git is not mid-operation", async () => {
    await render({ operation: null, conflictCount: 0 });

    expect(container.textContent).toBe("");
  });

  it("names the operation, its step, and the conflict count", async () => {
    await render(rebaseBlocked);

    expect(container.textContent).toContain("Rebase");
    expect(container.textContent).toContain("step 2 of 5");
    expect(container.textContent).toContain("3 conflicted paths");
  });

  it("blocks continue until every path is staged, and says why", async () => {
    await render(rebaseBlocked);

    const cont = button("Continue rebase");
    expect(cont.disabled).toBe(true);
    expect(cont.title).toContain("Stage all 3 conflicted paths");
    expect(button("Abort rebase").disabled).toBe(false);
  });

  /** An operation with nothing to resolve is still an operation. */
  it("enables continue when the operation has no conflicts", async () => {
    await render(rebaseClear);

    expect(button("Continue rebase").disabled).toBe(false);
    expect(container.textContent).toContain("No conflicts");
  });

  it("confirms before continuing and sends the observed operation kind", async () => {
    await render(rebaseClear);

    await act(async () => button("Continue rebase").click());

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Continue rebase?" })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith("operation:continue", {
      worktreeId: "worktree-1",
      operation: "rebase"
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("does not dispatch when the confirmation is declined", async () => {
    mocks.confirmDialog.mockResolvedValue(false);
    await render(rebaseClear);

    await act(async () => button("Continue rebase").click());

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  /**
   * The behaviour this component exists for. Git exits non-zero when a rebase
   * applies one step and stops on the next; that is progress, and reporting it
   * as an error is what made the earlier attempt at this feature unusable.
   */
  it("reports an advanced-and-stopped rebase as progress, not an error", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({
        kind: "stopped",
        state: {
          operation: {
            kind: "rebase",
            label: "Rebase",
            progress: { current: 3, total: 5 }
          },
          conflictCount: 1
        },
        detail: "Git stopped at step 3 of 5 on 1 conflicted path."
      })
    );
    await render(rebaseClear);

    await act(async () => button("Continue rebase").click());

    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.showInfoToast).toHaveBeenCalledWith({
      title: "Rebase advanced",
      message: "Git stopped at step 3 of 5 on 1 conflicted path."
    });
  });

  it("reports a finished operation as completed", async () => {
    await render(rebaseClear);

    await act(async () => button("Continue rebase").click());

    expect(mocks.showInfoToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Rebase completed" })
    );
  });

  it("surfaces a real failure as an error", async () => {
    mocks.dispatch.mockResolvedValue(
      err({ kind: "git", code: "continue_failed", message: "hook refused" })
    );
    await render(rebaseClear);

    await act(async () => button("Continue rebase").click());

    expect(mocks.showInfoToast).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).toHaveBeenCalledWith({
      title: "Could not continue rebase",
      message: "hook refused"
    });
  });

  it("confirms destructively before aborting", async () => {
    mocks.dispatch.mockResolvedValue(ok(null));
    await render(rebaseBlocked);

    await act(async () => button("Abort rebase").click());

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Abort rebase?", danger: true })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith("operation:abort", {
      worktreeId: "worktree-1",
      operation: "rebase"
    });
  });

  /** A conflicted stash apply leaves unmerged stages with no operation. */
  it("explains an unmerged index with no operation, and offers no way out", async () => {
    await render({ operation: null, conflictCount: 2 });

    expect(container.textContent).toContain("Unmerged index");
    expect(container.textContent).toContain("2 conflicted paths");
    expect(container.textContent).toContain("no operation in progress");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("uses the cherry-pick spelling Git accepts on the command line", async () => {
    await render({
      operation: { kind: "cherry-pick", label: "Cherry-pick" },
      conflictCount: 0
    });

    expect(button("Continue cherry-pick")).toBeTruthy();
    expect(button("Abort cherry-pick")).toBeTruthy();
  });
});
