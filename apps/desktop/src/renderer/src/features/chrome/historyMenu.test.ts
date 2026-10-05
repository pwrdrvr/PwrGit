import { describe, expect, it, vi } from "vitest";
import type { NavigationStacks } from "../../lib/useNavigationHistory";
import { agoLabel, buildHistoryMenu } from "./historyMenu";

const NOW = 10 * 60 * 60_000;
const stacks: NavigationStacks = {
  back: [
    { repoId: "r", worktreeId: "a", leftAt: NOW - 31 * 60_000 },
    {
      repoId: "r",
      worktreeId: "b",
      leftAt: NOW - 2 * 60_000,
      commit: { hash: "0a2a1d7ffff", subject: "Audit" }
    }
  ],
  cursor: { repoId: "r", worktreeId: "c" },
  forward: [
    { repoId: "r", worktreeId: "d", leftAt: NOW - 5_000 },
    { repoId: "r", worktreeId: "e", leftAt: NOW - 3 * 3_600_000 }
  ]
};

describe("buildHistoryMenu", () => {
  it("reads as the timeline: Forward furthest first, here, then Back nearest first", () => {
    const goBack = vi.fn();
    const goForward = vi.fn();
    const items = buildHistoryMenu({
      stacks,
      label: (location) => `PwrGit › ${location.worktreeId}`,
      goBack,
      goForward,
      now: NOW
    });
    const labels = items.map((item) => (item.type === "item" ? item.label : "—"));
    expect(labels).toEqual([
      "PwrGit › e",
      "PwrGit › d",
      "PwrGit › c",
      "PwrGit › b",
      "PwrGit › a"
    ]);

    const here = items[2];
    expect(here).toMatchObject({ disabled: true, hint: "You are here" });
    expect(items[3]).toMatchObject({ hint: "commit 0a2a1d7 · 2m ago" });
    expect(items[0]).toMatchObject({ hint: "3h ago" });

    if (items[4]?.type === "item") items[4].onSelect();
    expect(goBack).toHaveBeenCalledWith(2);
    if (items[0]?.type === "item") items[0].onSelect();
    expect(goForward).toHaveBeenCalledWith(2);
  });
});

describe("agoLabel", () => {
  it("phrases elapsed time the way the PR section's refresh line does", () => {
    expect(agoLabel(NOW - 10_000, NOW)).toBe("just now");
    expect(agoLabel(NOW - 9 * 60_000, NOW)).toBe("9m ago");
    expect(agoLabel(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(agoLabel(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });
});
