// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneBranchInfo } from "@pwrgit/shared";

const copyTextMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/copyText", () => ({ copyText: copyTextMock }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: vi.fn() }));

import { BranchChipMenu, type BranchChipTarget } from "./BranchChipMenu";

const branchInfo: Record<string, LaneBranchInfo> = {
  "feature/held": { worktreeId: "worktree-2", worktreePath: "/wt/held" },
  "feature/ready": {},
  main: { worktreeId: "worktree-1", worktreePath: "/repo" }
};

let container: HTMLDivElement;
let root: Root;
const onSwitchBranch = vi.fn();
const onRevealWorktree = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(
  target: Pick<BranchChipTarget, "ref" | "isRemote">
): Promise<void> {
  await act(async () => {
    root.render(
      <BranchChipMenu
        target={{ ...target, x: 10, y: 10 }}
        branchInfo={branchInfo}
        viewingBranch="main"
        worktreeId="worktree-1"
        onSwitchBranch={onSwitchBranch}
        onRevealWorktree={onRevealWorktree}
        onClose={() => undefined}
      />
    );
  });
}

/** The menu portals to <body>, so read items from there, not the container. */
function items(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent ?? ""
  );
}

function click(label: string): void {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === label
  );
  if (item === undefined) throw new Error(`no menu item labelled ${label}`);
  act(() => {
    (item as HTMLButtonElement).click();
  });
}

describe("BranchChipMenu", () => {
  it("switches to a branch no worktree holds", async () => {
    await render({ ref: "feature/ready", isRemote: false });
    expect(items()).toEqual([
      "Switch to feature/ready",
      "Copy branch name"
    ]);

    click("Switch to feature/ready");
    expect(onSwitchBranch).toHaveBeenCalledWith({
      branch: "feature/ready",
      ref: "feature/ready",
      isRemoteOnly: false
    });
  });

  it("offers the worktree holding a branch instead of a doomed switch", async () => {
    await render({ ref: "feature/held", isRemote: false });
    expect(items()).toEqual([
      "Open its worktree",
      "Copy branch name",
      "Copy worktree path"
    ]);

    click("Open its worktree");
    expect(onRevealWorktree).toHaveBeenCalledWith("worktree-2");
    click("Copy worktree path");
    expect(copyTextMock).toHaveBeenCalledWith("/wt/held");
  });

  it("copies the branch already checked out here, with nothing to switch to", async () => {
    await render({ ref: "main", isRemote: false });
    expect(items()).toEqual(["Copy branch name", "Copy worktree path"]);

    click("Copy branch name");
    expect(copyTextMock).toHaveBeenCalledWith("main");
  });

  it("names the local branch a remote chip would check out", async () => {
    await render({ ref: "origin/feature/theirs", isRemote: true });
    expect(items()).toEqual([
      "Switch to feature/theirs from origin/feature/theirs",
      "Copy branch name"
    ]);

    // The chip's own text is what gets copied — that is what is on screen.
    click("Copy branch name");
    expect(copyTextMock).toHaveBeenCalledWith("origin/feature/theirs");
  });
});
