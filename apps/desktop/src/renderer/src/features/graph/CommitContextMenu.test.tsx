// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@pwrgit/shared";

vi.mock("../../lib/copyText", () => ({ copyText: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: vi.fn() }));

import { CommitContextMenu, pushedWarning } from "./CommitContextMenu";
import type { GraphRowVM } from "./GraphRow";
import type { HistoryRange } from "./history-range";

const commit: Commit = {
  hash: "c".repeat(40),
  shortHash: "ccccccc",
  parents: ["b".repeat(40)],
  subject: "Read papers from disk",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  committedAt: "2026-11-14T00:00:00Z",
  isMerge: false
};
const vm = {
  commit,
  refs: [],
  remoteRefs: [],
  isHead: false,
  isHeadOnly: true,
  isMine: true,
  defaultBranch: "main"
} as unknown as GraphRowVM;

let container: HTMLDivElement;
let root: Root;
const onEditHistory = vi.fn();

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

async function render(historyRange: HistoryRange | null): Promise<void> {
  await act(async () => {
    root.render(
      <CommitContextMenu
        x={10}
        y={10}
        vm={vm}
        branchInfo={{}}
        viewingBranch="main"
        worktreeId="worktree-1"
        onViewChanges={() => undefined}
        onBranchFrom={() => undefined}
        onTagFrom={() => undefined}
        onSwitchBranch={() => undefined}
        onRevealWorktree={() => undefined}
        historyRange={historyRange}
        onEditHistory={onEditHistory}
        onClose={() => undefined}
      />
    );
  });
}

function entry(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => (item.textContent ?? "").startsWith(label)
  );
}

function headings(): string[] {
  return [...document.querySelectorAll(".pop-menu__heading")].map((h) => h.textContent ?? "");
}

describe("CommitContextMenu › Edit history from here", () => {
  const hashes = ["a".repeat(40), "b".repeat(40), commit.hash];

  it("names the run's size and hands the run to the chosen operation", async () => {
    await render({ kind: "range", hashes, pushed: 0 });
    expect(headings()).toContain("Edit history from here");
    expect(entry("Reorder 3 commits…")).toBeDefined();

    act(() => entry("Squash 3 commits into one…")?.click());
    expect(onEditHistory).toHaveBeenCalledWith(hashes, "squash");
  });

  it("says nothing about pushing when the whole run is local", async () => {
    await render({ kind: "range", hashes, pushed: 0 });
    expect(document.querySelector(".pop-menu__heading-hint")).toBeNull();
    expect(entry("Squash 3 commits into one…")?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("warns once, under the heading, when the run holds pushed commits", async () => {
    await render({ kind: "range", hashes, pushed: 2 });
    const hint = document.querySelector(".pop-menu__heading-hint");
    expect(hint?.textContent).toBe(
      "2 of these 3 are already pushed. Publishing the rewrite needs a force push."
    );
    // Every entry in the group is described by it; nothing outside is.
    for (const label of ["Squash 3", "Reorder 3"]) {
      expect(entry(label)?.getAttribute("aria-describedby")).toBe(hint?.id);
    }
    expect(entry("Copy short SHA")?.hasAttribute("aria-describedby")).toBe(false);
    expect(entry("View changes")?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("words the warning for one, some, both and all", () => {
    expect(pushedWarning(1, 3)).toBe(
      "1 of these 3 is already pushed. Publishing the rewrite needs a force push."
    );
    expect(pushedWarning(2, 2)).toBe(
      "Both are already pushed. Publishing the rewrite needs a force push."
    );
    expect(pushedWarning(5, 5)).toBe(
      "All 5 are already pushed. Publishing the rewrite needs a force push."
    );
  });

  it("describes Squash and Reorder on a blocked run", async () => {
    await render({ kind: "blocked", reason: "root", count: 2 });
    expect(entry("Squash or reorder 2 commits")?.disabled).toBe(true);
  });

  it("offers nothing where there is no run", async () => {
    await render(null);
    expect(headings()).not.toContain("Edit history from here");
    expect(entry("Squash")).toBeUndefined();
  });
});
