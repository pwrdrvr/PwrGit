// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PWRGIT_PULL_STASH_MESSAGE,
  ok,
  type Result,
  type StashEntry,
  type Worktree
} from "@pwrgit/shared";
import { StashesTab } from "./StashesTab";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
  confirmDialog: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({ dispatch: mocks.dispatch }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: mocks.showErrorToast,
  showInfoToast: mocks.showInfoToast
}));
vi.mock("../shell/dialogs", () => ({ confirmDialog: mocks.confirmDialog }));

const stash = (
  selector: string,
  hash: string,
  name: string,
  kind: StashEntry["kind"] = "ordinary"
): StashEntry => ({
  selector,
  hash,
  occurrenceCount: 1,
  shortHash: hash.slice(0, 7),
  baseHash: "b".repeat(40),
  branch: selector === "stash@{0}" ? "feature/other" : "main",
  subject: "On main: " + name,
  name,
  kind,
  createdAt: "2026-08-23T12:00:00Z"
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("StashesTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let reload: () => Promise<void>;
  let reloadMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const recovery = stash(
    "stash@{0}",
    "0".repeat(40),
    PWRGIT_PULL_STASH_MESSAGE,
    "pwrgit-pull-recovery"
  );
  const older = stash("stash@{1}", "1".repeat(40), "older CLI stash");
  const worktree = {
    id: "worktree-1",
    repoId: "repo-1",
    branch: "main"
  } as Worktree;
  const otherWorktree = {
    id: "worktree-2",
    repoId: "repo-2",
    branch: "feature/other-repo"
  } as Worktree;

  const renderTab = async (
    selectedWorktree: Worktree = worktree,
    selectedEntries: StashEntry[] = [recovery, older],
    selectedReload: () => Promise<void> = reload
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <StashesTab
          worktree={selectedWorktree}
          entries={selectedEntries}
          loading={false}
          reload={selectedReload}
          onOpenPatch={vi.fn()}
        />
      );
    });
  };

  const setName = async (value: string): Promise<void> => {
    const input = container.querySelector<HTMLInputElement>("#stash-name");
    if (input === null) throw new Error("stash name input missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    reloadMock = vi.fn<() => Promise<void>>(async () => undefined);
    reload = reloadMock;
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "stash:details") {
        return ok({
          entry: older,
          files: [{ path: "README.md", additions: 2, deletions: 1 }],
          additions: 2,
          deletions: 1
        });
      }
      if (command === "stash:create") return ok({ created: true });
      return ok(null);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await renderTab();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const button = (text: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === text
    );
    if (found === undefined) throw new Error("button not found: " + text);
    return found;
  };

  it("labels repository/worktree scope and PwrGit pull recovery entries", async () => {
    expect(container.textContent).toContain("Repository stack · 2");
    expect(container.textContent).toContain("Shared by every worktree");

    // The chip sits outside the truncating name, so it can never be the part
    // that gets ellipsized away on the (long) auto-stash message.
    const chip = container.querySelector(".stash-entry__recovery");
    expect(chip?.textContent).toBe("Pull recovery");
    expect(chip?.closest(".stash-entry__name")).toBeNull();
    expect(
      container.querySelectorAll(".stash-entry__recovery")
    ).toHaveLength(1);

    // Where Apply/Pop land is stated beside the actions, per worktree.
    const inspect = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect older CLI stash"]'
    );
    if (inspect === null) throw new Error("inspect button missing");
    await act(async () => inspect.click());
    expect(container.querySelector(".stash-entry__target")?.textContent).toContain(
      "Apply and Pop restore into main"
    );
  });

  it("inspects and pops the selected non-top entry by stable hash", async () => {
    const inspect = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect older CLI stash"]'
    );
    if (inspect === null) throw new Error("inspect button missing");
    await act(async () => inspect.click());

    expect(mocks.dispatch).toHaveBeenCalledWith("stash:details", {
      worktreeId: "worktree-1",
      stashHash: older.hash
    });
    expect(container.textContent).toContain("README.md");
    expect(container.textContent).toContain("+2 −1");

    await act(async () => button("Pop").click());
    expect(mocks.dispatch).toHaveBeenCalledWith("stash:pop", {
      worktreeId: "worktree-1",
      stashHash: older.hash
    });
    expect(reloadMock).toHaveBeenCalled();
  });

  it("creates a named stash with the explicit untracked choice", async () => {
    const include = container.querySelector<HTMLInputElement>(
      '.stash-create__option input[type="checkbox"]'
    );
    if (include === null) throw new Error("create form missing");
    await setName("tracked experiment");
    await act(async () => {
      include.click();
    });
    await act(async () => button("Stash changes").click());

    expect(mocks.dispatch).toHaveBeenCalledWith("stash:create", {
      worktreeId: "worktree-1",
      message: "tracked experiment",
      includeUntracked: false
    });
  });

  it("warns that dropping removes a repository-wide entry", async () => {
    const inspect = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect older CLI stash"]'
    );
    if (inspect === null) throw new Error("inspect button missing");
    await act(async () => inspect.click());
    await act(async () => button("Drop").click());

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Drop repository stash?",
        message: expect.stringContaining("shared by every worktree")
      })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith("stash:drop", {
      worktreeId: "worktree-1",
      stashHash: older.hash
    });
  });

  it("ignores a create completion after another worktree is selected", async () => {
    const pending = deferred<Result<{ created: boolean }>>();
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "stash:create") return pending.promise;
      return ok(null);
    });
    const oldReload = vi.fn(async () => undefined);
    const newReload = vi.fn(async () => undefined);
    await renderTab(worktree, [recovery, older], oldReload);
    await setName("from old repo");
    await act(async () => button("Stash changes").click());

    await renderTab(otherWorktree, [], newReload);
    await setName("new repo draft");
    await act(async () => {
      pending.resolve(ok({ created: true }));
      await pending.promise;
    });

    expect(oldReload).not.toHaveBeenCalled();
    expect(newReload).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>("#stash-name")?.value).toBe(
      "new repo draft"
    );
    expect(mocks.showInfoToast).not.toHaveBeenCalled();
  });

  it("ignores a pop completion after another worktree is selected", async () => {
    const pending = deferred<Result<undefined>>();
    const oldReload = vi.fn(async () => undefined);
    const newReload = vi.fn(async () => undefined);
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "stash:details") {
        return ok({ entry: older, files: [], additions: 0, deletions: 0 });
      }
      if (command === "stash:pop") return pending.promise;
      return ok(null);
    });
    await renderTab(worktree, [recovery, older], oldReload);
    const inspect = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect older CLI stash"]'
    );
    if (inspect === null) throw new Error("inspect button missing");
    await act(async () => inspect.click());
    await act(async () => button("Pop").click());

    await renderTab(otherWorktree, [], newReload);
    await act(async () => {
      pending.resolve(ok(undefined));
      await pending.promise;
    });

    expect(oldReload).not.toHaveBeenCalled();
    expect(newReload).not.toHaveBeenCalled();
    expect(mocks.showInfoToast).not.toHaveBeenCalled();
  });

  it("does not drop from an old worktree when selection changes during confirmation", async () => {
    const pendingConfirmation = deferred<boolean>();
    mocks.confirmDialog.mockReturnValueOnce(pendingConfirmation.promise);
    const inspect = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect older CLI stash"]'
    );
    if (inspect === null) throw new Error("inspect button missing");
    await act(async () => inspect.click());
    await act(async () => button("Drop").click());

    await renderTab(otherWorktree, []);
    await act(async () => {
      pendingConfirmation.resolve(true);
      await pendingConfirmation.promise;
    });

    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      "stash:drop",
      expect.anything()
    );
  });

  it("renders duplicate occurrences separately and disables destructive actions", async () => {
    const hash = "d".repeat(40);
    const duplicateTop = {
      ...stash("stash@{0}", hash, "duplicate"),
      occurrenceCount: 2
    };
    const duplicateOlder = {
      ...stash("stash@{2}", hash, "duplicate"),
      occurrenceCount: 2
    };
    await renderTab(worktree, [duplicateTop, duplicateOlder]);
    const inspectButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Inspect duplicate"]'
    );
    expect(inspectButtons).toHaveLength(2);
    const olderInspect = inspectButtons[1];
    if (olderInspect === undefined) throw new Error("older duplicate missing");
    await act(async () => olderInspect.click());

    expect(container.textContent).toContain(
      "same Git stash object appears 2 times"
    );
    // aria-disabled rather than `disabled`, so the pointer still gets the
    // tooltip saying why — and a click is refused by the handler.
    expect(button("Pop").getAttribute("aria-disabled")).toBe("true");
    expect(button("Drop").getAttribute("aria-disabled")).toBe("true");
    expect(button("Apply").hasAttribute("aria-disabled")).toBe(false);
    expect(container.querySelector(".stash-entry__target")?.textContent).toContain(
      "Apply restores into main"
    );
    await act(async () => button("Pop").click());
    await act(async () => button("Drop").click());
    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      "stash:pop",
      expect.anything()
    );
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
  });

  it("keeps focus and the file list in place while a command runs", async () => {
    const pending = deferred<Result<undefined>>();
    mocks.dispatch.mockImplementation(async (command: string) => {
      if (command === "stash:details") {
        return ok({
          entry: older,
          files: [{ path: "README.md", additions: 2, deletions: 1 }],
          additions: 2,
          deletions: 1
        });
      }
      if (command === "stash:apply") return pending.promise;
      return ok(null);
    });
    const inspect = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect older CLI stash"]'
    );
    if (inspect === null) throw new Error("inspect button missing");
    await act(async () => inspect.click());
    const apply = button("Apply");
    apply.focus();
    await act(async () => apply.click());

    // In flight is aria-disabled, never `disabled`: a disabled button drops
    // focus to <body> for the length of the command.
    expect(apply.disabled).toBe(false);
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(apply);
    expect(container.textContent).toContain("Applying…");
    expect(container.textContent).toContain("README.md");

    // A second command is refused while the first is running.
    await act(async () => button("Pop").click());
    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      "stash:pop",
      expect.anything()
    );

    await act(async () => {
      pending.resolve(ok(undefined));
      await pending.promise;
    });
    expect(apply.hasAttribute("aria-disabled")).toBe(false);
  });
});
