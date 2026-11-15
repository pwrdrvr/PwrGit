// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@pwrgit/shared";

vi.mock("../../lib/copyText", () => ({ copyText: vi.fn() }));
vi.mock("../../lib/pwrgit", () => ({ dispatch: vi.fn() }));

import { CommitContextMenu } from "./CommitContextMenu";
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

async function render(historyRange: HistoryRange | null, tidyOffered: boolean): Promise<void> {
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
        tidyOffered={tidyOffered}
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
    await render({ kind: "range", hashes }, true);
    expect(headings()).toContain("Edit history from here");
    expect(entry("Reorder 3 commits…")).toBeDefined();
    expect(entry("Tidy 3 commits with an agent…")).toBeDefined();

    act(() => entry("Squash 3 commits into one…")?.click());
    expect(onEditHistory).toHaveBeenCalledWith(hashes, "squash");
  });

  it("leaves Tidy out where AI history editing is off", async () => {
    await render({ kind: "range", hashes }, false);
    expect(entry("Squash 3 commits into one…")).toBeDefined();
    expect(entry("Tidy")).toBeUndefined();
  });

  it("shows a blocked run disabled, with the reason", async () => {
    await render({ kind: "blocked", reason: "merge", count: 4 }, true);
    const blocked = entry("Squash, reorder or tidy 4 commits");
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.textContent).toContain("A merge sits between here and HEAD.");
  });

  it("does not name Tidy on a blocked run where AI is off", async () => {
    await render({ kind: "blocked", reason: "root", count: 2 }, false);
    expect(entry("Squash or reorder 2 commits")?.disabled).toBe(true);
    expect(entry("Squash, reorder or tidy")).toBeUndefined();
  });

  it("offers nothing where there is no run", async () => {
    await render(null, true);
    expect(headings()).not.toContain("Edit history from here");
    expect(entry("Squash")).toBeUndefined();
  });
});
