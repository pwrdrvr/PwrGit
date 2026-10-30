import { describe, expect, it, vi } from "vitest";
import type { Worktree } from "@pwrgit/shared";
import type { MenuItem } from "./ContextMenu";
import {
  MISSING_RESET_HINT,
  PRIMARY_REMOVE_HINT,
  worktreeMenuItems
} from "./worktree-menu-items";

const worktree = (overrides: Partial<Worktree> = {}): Worktree =>
  ({
    id: "wt-1",
    repoId: "repo-1",
    path: "/code/widget",
    branch: "main",
    isPrimary: false,
    ...overrides
  }) as Worktree;

const labels = (items: MenuItem[]): string[] =>
  items.map((item) => (item.type === "sep" ? "—" : item.label));

const entry = (items: MenuItem[], label: string) => {
  const found = items.find(
    (item) => item.type === "item" && item.label === label
  );
  if (found === undefined || found.type !== "item") {
    throw new Error(`no "${label}" in ${labels(items).join(", ")}`);
  }
  return found;
};

describe("worktreeMenuItems", () => {
  it("lists one worktree's actions in one order", () => {
    const items = worktreeMenuItems({
      worktree: worktree(),
      platform: "darwin",
      onResetToRemote: vi.fn(),
      onRemove: vi.fn()
    });
    expect(labels(items)).toEqual([
      "Copy branch name",
      "Copy path",
      "Reveal in Finder",
      "—",
      "Reset to remote branch…",
      "—",
      "Remove worktree"
    ]);
  });

  it("keeps Remove on the primary checkout, disabled, and says where removal lives", () => {
    const onRemove = vi.fn();
    const remove = entry(
      worktreeMenuItems({
        worktree: worktree({ isPrimary: true }),
        onResetToRemote: vi.fn(),
        onRemove
      }),
      "Remove worktree"
    );
    expect(remove.disabled).toBe(true);
    expect(remove.hint).toBe(PRIMARY_REMOVE_HINT);
  });

  it("keeps Reset on a missing checkout, disabled, with its reason", () => {
    const reset = entry(
      worktreeMenuItems({
        worktree: worktree({ missing: true }),
        onResetToRemote: vi.fn(),
        onRemove: vi.fn()
      }),
      "Reset to remote branch…"
    );
    expect(reset.disabled).toBe(true);
    expect(reset.hint).toBe(MISSING_RESET_HINT);
  });

  it("puts Fork before Reset where the surface offers it", () => {
    const items = worktreeMenuItems({
      worktree: worktree(),
      platform: "darwin",
      fork: { label: "Fork acme/widget…", onSelect: vi.fn() },
      onResetToRemote: vi.fn()
    });
    expect(labels(items)).toEqual([
      "Copy branch name",
      "Copy path",
      "Reveal in Finder",
      "—",
      "Fork acme/widget…",
      "Reset to remote branch…"
    ]);
  });
});
