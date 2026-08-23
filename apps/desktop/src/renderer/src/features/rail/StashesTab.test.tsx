// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PWRGIT_PULL_STASH_MESSAGE,
  ok,
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
  shortHash: hash.slice(0, 7),
  baseHash: "b".repeat(40),
  branch: selector === "stash@{0}" ? "feature/other" : "main",
  subject: "On main: " + name,
  name,
  kind,
  createdAt: "2026-08-23T12:00:00Z"
});

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
    await act(async () => {
      root.render(
        <StashesTab
          worktree={worktree}
          entries={[recovery, older]}
          loading={false}
          reload={reload}
          onOpenPatch={vi.fn()}
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
    if (found === undefined) throw new Error("button not found: " + text);
    return found;
  };

  it("labels repository/worktree scope and PwrGit pull recovery entries", () => {
    expect(container.textContent).toContain(
      "One Git stash stack for this repository."
    );
    expect(container.textContent).toContain(
      "Every linked worktree sees these entries."
    );
    expect(container.textContent).toContain("PwrGit pull recovery");
    expect(container.textContent).toContain("Repository stack · 2");
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
    const input = container.querySelector<HTMLInputElement>("#stash-name");
    const include = container.querySelector<HTMLInputElement>(
      '.stash-create__option input[type="checkbox"]'
    );
    if (input === null || include === null) throw new Error("create form missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "tracked experiment");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
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
});
