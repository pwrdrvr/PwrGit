// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Commit } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { showInfoToast } from "../../lib/toast";
import { BranchFromCommitDialog } from "./BranchFromCommitDialog";

const commit: Commit = {
  hash: "466c894abcdef0123456789abcdef0123456789a",
  shortHash: "466c894",
  parents: ["425a811"],
  subject: "fix(desktop): reconcile native sub-agent accounting (#1727)",
  authorName: "Harold Hunt",
  authorEmail: "you@example.com",
  committedAt: new Date("2026-08-17T00:00:00Z").toISOString(),
  isMerge: false
};

let container: HTMLDivElement;
let root: Root;
const onCreated = vi.fn();
const onClose = vi.fn();

/** Reply per command so the dialog's parallel loads all resolve. */
function respond({ dirty = 0, branches = ["main"] } = {}): void {
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "branch:localNames") {
      return Promise.resolve(ok(branches));
    }
    if (channel === "worktree:getState") {
      return Promise.resolve(ok({ dirty }));
    }
    if (channel === "worktree:pathPreview") {
      return Promise.resolve(ok({ path: "/wt/PwrAgnt/fix-accounting" }));
    }
    return Promise.resolve(
      ok({ checkedOutWorktreeId: "worktree-2", worktreePath: null })
    );
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <BranchFromCommitDialog
        repoId="repo-1"
        repoName="PwrAgnt"
        worktreeId="worktree-1"
        viewingBranch="main"
        commit={commit}
        now={Date.parse("2026-08-17T12:00:00Z")}
        onCreated={onCreated}
        onClose={onClose}
      />
    );
  });
}

const input = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(".modal__input")!;

const radio = (value: string): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;

const createButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(".modal__create")!;

async function type(value: string): Promise<void> {
  const field = input();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  respond();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("BranchFromCommitDialog", () => {
  it("prefills a branch name suggested by the commit subject", async () => {
    await render();

    expect(input().value).toBe("reconcile-native-sub-agent-accounting");
    expect(container.textContent).toContain("Branch from 466c894 · PwrAgnt");
    expect(container.textContent).toContain(commit.subject);
  });

  it("defaults to creating the ref alone and sends that on submit", async () => {
    await render();
    await act(async () => createButton().click());

    expect(dispatchMock).toHaveBeenCalledWith("branch:create", {
      worktreeId: "worktree-1",
      branch: "reconcile-native-sub-agent-accounting",
      startPoint: commit.hash,
      checkout: "none"
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("remembers the last checkout choice for the next opening", async () => {
    await render();
    await act(async () => radio("new-worktree").click());
    await act(async () => createButton().click());

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    expect(radio("new-worktree").checked).toBe(true);
    expect(container.textContent).toContain("Create branch & worktree");
  });

  it("shows the path the worktree would be created at", async () => {
    await render();
    await act(async () => radio("new-worktree").click());

    expect(dispatchMock).toHaveBeenCalledWith("worktree:pathPreview", {
      repoId: "repo-1",
      branch: "reconcile-native-sub-agent-accounting"
    });
    expect(container.textContent).toContain("/wt/PwrAgnt/fix-accounting");
  });

  it("disables an in-place checkout while the worktree is dirty", async () => {
    respond({ dirty: 3 });
    await render();

    expect(radio("here").disabled).toBe(true);
    expect(container.textContent).toContain(
      "Unavailable — main has uncommitted changes"
    );
  });

  it("falls back for this opening without forgetting the stored choice", async () => {
    window.localStorage.setItem("pwrgit.branchCheckoutTarget", "here");
    respond({ dirty: 1 });
    await render();

    expect(radio("new-worktree").checked).toBe(true);
    expect(window.localStorage.getItem("pwrgit.branchCheckoutTarget")).toBe(
      "here"
    );
  });

  it("keeps the stored choice when the fallback is accepted as-is", async () => {
    window.localStorage.setItem("pwrgit.branchCheckoutTarget", "here");
    respond({ dirty: 1 });
    await render();
    await act(async () => createButton().click());

    // Creating from the substitute is not a decision to abandon "here" — the
    // next clean worktree must still open on it.
    expect(window.localStorage.getItem("pwrgit.branchCheckoutTarget")).toBe(
      "here"
    );
  });

  it("stores a target the user picks over the fallback", async () => {
    window.localStorage.setItem("pwrgit.branchCheckoutTarget", "here");
    respond({ dirty: 1 });
    await render();
    await act(async () => radio("none").click());
    await act(async () => createButton().click());

    expect(window.localStorage.getItem("pwrgit.branchCheckoutTarget")).toBe(
      "none"
    );
  });

  it("blocks a name that already exists", async () => {
    respond({ branches: ["main", "taken"] });
    await render();
    await type("taken");

    expect(createButton().disabled).toBe(true);
    expect(container.textContent).toContain("A branch named taken already exists");
  });

  it("blocks a malformed name and creates nothing", async () => {
    await render();
    await type("bad name");

    expect(createButton().disabled).toBe(true);
    await act(async () => createButton().click());
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "branch:create",
      expect.anything()
    );
  });

  it("reveals a worktree the branch was checked out into", async () => {
    await render();
    await act(async () => radio("new-worktree").click());
    await act(async () => createButton().click());

    expect(onCreated).toHaveBeenCalledExactlyOnceWith("worktree-2");
  });

  describe("Escape", () => {
    const escape = async (): Promise<void> => {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      });
    };

    it("closes the dialog when focus is inside it", async () => {
      await render();
      input().focus();
      await escape();

      expect(onClose).toHaveBeenCalledOnce();
    });

    it("still closes once focus has fallen back to the body", async () => {
      await render();
      // What happens after an overlay opened over the dialog closes again.
      (document.activeElement as HTMLElement | null)?.blur();
      await escape();

      expect(onClose).toHaveBeenCalledOnce();
    });

    it("leaves the keystroke to an overlay that owns the focus", async () => {
      await render();
      const elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      elsewhere.focus();

      await escape();

      expect(onClose).not.toHaveBeenCalled();
      elsewhere.remove();
    });
  });

  it("asks for local branch names only, never the full ref list", async () => {
    await render();

    expect(dispatchMock).toHaveBeenCalledWith("branch:localNames", {
      worktreeId: "worktree-1"
    });
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "branch:list",
      expect.anything()
    );
  });

  describe("while a slow create is running", () => {
    /** Hold branch:create open so the dialog stays in its busy state. */
    function holdCreate(): { finish: () => void } {
      let release!: () => void;
      const pending = new Promise((resolve) => {
        release = () =>
          resolve(ok({ checkedOutWorktreeId: "worktree-2", worktreePath: null }));
      });
      const base = dispatchMock.getMockImplementation()!;
      dispatchMock.mockImplementation((channel: string, req: unknown) =>
        channel === "branch:create" ? pending : base(channel, req)
      );
      return { finish: release };
    }

    it("can still be dismissed, and says the work continues", async () => {
      await render();
      const held = holdCreate();
      await act(async () => createButton().click());

      const cancel = container.querySelector<HTMLButtonElement>(".modal__cancel")!;
      expect(cancel.disabled).toBe(false);
      expect(cancel.textContent).toBe("Close");

      await act(async () => cancel.click());
      expect(onClose).toHaveBeenCalledOnce();
      expect(showInfoToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Still creating" })
      );

      held.finish();
    });

    it("still confirms the outcome after the dialog is gone", async () => {
      await render();
      const held = holdCreate();
      await act(async () => createButton().click());
      await act(async () => root.unmount());

      await act(async () => {
        held.finish();
      });

      // The toast is the only trace left once the dialog has been dismissed,
      // so it must not be lost with it…
      expect(showInfoToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Branch created" })
      );
      // …but dismissing is the user choosing to be elsewhere, so nothing drags
      // their selection to the worktree that just finished.
      expect(onCreated).not.toHaveBeenCalled();

      root = createRoot(container);
    });
  });
});
