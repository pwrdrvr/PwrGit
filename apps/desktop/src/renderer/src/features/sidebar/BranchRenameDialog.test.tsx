// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type LocalBranchSummary } from "@pwrgit/shared";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { BranchRenameDialog } from "./BranchRenameDialog";

const branch: LocalBranchSummary = {
  name: "feature/old",
  fullName: "refs/heads/feature/old",
  head: "a".repeat(40),
  upstream: "origin/feature/old",
  ahead: 0,
  behind: 0,
  tracking: "up_to_date",
  checkedOutWorktreeIds: []
};

let container: HTMLDivElement;
let root: Root;
const onRenamed = vi.fn();
const onClose = vi.fn();

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <BranchRenameDialog
        repoId="repo-1"
        branch={branch}
        existingBranches={["main", branch.name, "feature/taken"]}
        onRenamed={onRenamed}
        onClose={onClose}
      />
    );
  });
}

async function fill(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(".modal__input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatch.mockResolvedValue(ok(null));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("BranchRenameDialog", () => {
  it("sends the reviewed tip and the trimmed new local name", async () => {
    await render();
    await fill("  feature/new  ");
    const button = container.querySelector<HTMLButtonElement>(".modal__create")!;
    await act(async () => button.click());

    expect(dispatch).toHaveBeenCalledExactlyOnceWith("branch:rename", {
      repoId: "repo-1",
      branch: "feature/old",
      newBranch: "feature/new",
      expectedHead: "a".repeat(40)
    });
    expect(onRenamed).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("blocks unchanged, existing, and malformed names", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>(".modal__create")!;
    expect(button.disabled).toBe(true);

    await fill("feature/taken");
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("already exists");

    await fill("bad name");
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("can't contain spaces");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when main rejects a stale reviewed tip", async () => {
    dispatch.mockResolvedValueOnce(
      err({
        kind: "repo",
        code: "stale_branch",
        message: "feature/old moved after it was shown"
      })
    );
    await render();
    await fill("feature/new");
    const button = container.querySelector<HTMLButtonElement>(".modal__create")!;
    await act(async () => button.click());

    expect(container.textContent).toContain("moved after it was shown");
    expect(onRenamed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
