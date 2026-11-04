// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkSyncSummary } from "@pwrgit/shared";
import { SidebarToolbar, addMenuReasons, lastRunHint, syncFace } from "./SidebarToolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The sidebar's one row of profile-wide actions. What these pin: every action
 * the old five-row stack offered is still here under the name the E2E suite
 * and voice control use, Add ▾ explains a disabled entry instead of hiding
 * it, and each entry runs the handler it names.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function handlers() {
  return {
    onAddFolder: vi.fn(),
    onClone: vi.fn(),
    onFork: vi.fn(),
    onSync: vi.fn(),
    onMaintenance: vi.fn()
  };
}

function render(
  props: {
    hasProfile: boolean;
    rootCount: number;
    repoCount: number;
  } & Partial<Parameters<typeof SidebarToolbar>[0]>,
  h = handlers()
) {
  act(() => {
    root.render(<SidebarToolbar {...props} {...h} />);
  });
  return h;
}

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (el) => el.getAttribute("aria-label") === name
  );
  if (found === undefined) throw new Error(`no button named ${name}`);
  return found;
};

const menuItem = (label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  ].find((el) => el.textContent?.startsWith(label) === true);
  if (found === undefined) throw new Error(`no menu item ${label}`);
  return found;
};

describe("addMenuReasons", () => {
  it("names a reason for every entry until a profile has loaded", () => {
    expect(addMenuReasons({ hasProfile: false, rootCount: 0 })).toEqual({
      addFolders: "Load or create a profile first",
      clone: "Load or create a profile first",
      fork: "Load or create a profile first"
    });
  });

  it("leaves Add folders available and explains Clone and Fork with no folder", () => {
    expect(addMenuReasons({ hasProfile: true, rootCount: 0 })).toEqual({
      clone: "Add a repo folder before cloning",
      fork: "Add a repo folder before forking"
    });
  });

  it("has nothing to explain once a folder exists", () => {
    expect(addMenuReasons({ hasProfile: true, rootCount: 2 })).toEqual({});
  });
});

describe("SidebarToolbar", () => {
  it("keeps the names the old buttons used, each containing its visible label", () => {
    render({ hasProfile: true, rootCount: 1, repoCount: 3 });
    const pairs: Array<[string, string]> = [
      ["Fetch all repos", "Fetch all"],
      ["Add repositories", "Add"]
    ];
    for (const [name, visible] of pairs) {
      expect(button(name).textContent).toContain(visible);
      expect(name.toLowerCase()).toContain(visible.toLowerCase());
    }
    // Icon-only: the name is the whole label.
    expect(button("Repository maintenance…").textContent).toBe("");
  });

  it("is one sync button: Pull is a choice on it, not a second button", () => {
    render({ hasProfile: true, rootCount: 1, repoCount: 3, syncVerb: "pull" });
    const face = button("Try pull all");
    expect(face.textContent).toContain("Pull all");
    expect(() => button("Fetch all repos")).toThrow();
  });

  it("runs the face and maintenance from one click each", () => {
    const h = render({ hasProfile: true, rootCount: 1, repoCount: 3 });
    act(() => button("Fetch all repos").click());
    act(() => button("Repository maintenance…").click());
    expect(h.onSync).toHaveBeenCalledTimes(1);
    expect(h.onMaintenance).toHaveBeenCalledTimes(1);
  });

  it("disables the sync button while there is no repository", () => {
    render({ hasProfile: true, rootCount: 0, repoCount: 0 });
    expect(button("Fetch all repos").disabled).toBe(true);
    expect(button("Sync options").disabled).toBe(true);
    expect(button("Repository maintenance…").disabled).toBe(false);
  });

  it("opens Add with Add folders, Clone and Fork, and runs the one picked", () => {
    const h = render({ hasProfile: true, rootCount: 1, repoCount: 3 });
    const add = button("Add repositories");
    expect(add.getAttribute("aria-expanded")).toBe("false");
    act(() => add.click());
    expect(add.getAttribute("aria-expanded")).toBe("true");
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
    ).toEqual(["Add folders…", "Clone…", "Fork…"]);
    act(() => menuItem("Clone…").click());
    expect(h.onClone).toHaveBeenCalledTimes(1);
    // Picking closes the menu.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => add.click());
    act(() => menuItem("Fork…").click());
    expect(h.onFork).toHaveBeenCalledTimes(1);
  });

  it("keeps Clone and Fork in the menu, disabled with the reason, before any folder", () => {
    const h = render({ hasProfile: true, rootCount: 0, repoCount: 0 });
    act(() => button("Add repositories").click());
    const clone = menuItem("Clone…");
    expect(clone.disabled).toBe(true);
    expect(clone.textContent).toContain("Add a repo folder before cloning");
    expect(menuItem("Fork…").disabled).toBe(true);
    const addFolders = menuItem("Add folders…");
    expect(addFolders.disabled).toBe(false);
    act(() => addFolders.click());
    expect(h.onAddFolder).toHaveBeenCalledTimes(1);
  });

  it("names the face after the remembered verb and scope", () => {
    render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      recentCount: 2,
      syncScope: "recent"
    });
    const face = button("Fetch recent repos");
    expect(face.textContent).toContain("Fetch recent");
    expect(face.disabled).toBe(false);
  });

  it("disables a recent face while the Focused list is empty", () => {
    render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      recentCount: 0,
      syncVerb: "pull",
      syncScope: "recent"
    });
    expect(button("Try pull recent").disabled).toBe(true);
    // The chevron still opens, so the choice can be changed back.
    expect(button("Sync options").disabled).toBe(false);
  });

  it("offers the four actions and every interval as radio entries, and stays open for each pick", () => {
    const onPickSync = vi.fn();
    const onPickFetchInterval = vi.fn();
    render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      recentCount: 2,
      fetchInterval: 5,
      onPickSync,
      onPickFetchInterval
    });
    const chevron = button("Sync options");
    const caret = (): string | null | undefined =>
      chevron.querySelector("path")?.getAttribute("d");
    expect(caret()).toBe("m6 9 6 6 6-6");
    act(() => chevron.click());
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    // The caret points up while its menu is open, as PwrAgnt's Send caret.
    expect(caret()).toBe("m18 15-6-6-6 6");
    const radios = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ];
    // An entry with a hint stacks label over hint; read the label alone.
    const label = (el: Element): string | null =>
      (el.querySelector(".pop-menu__stack > span:first-child") ?? el).textContent;
    expect(radios.map(label)).toEqual([
      "Fetch all repositories",
      "Fetch recent repositories",
      "Pull all repositories",
      "Pull recent repositories",
      "Off",
      "Every minute",
      "Every 5 minutes",
      "Every 15 minutes",
      "Every hour"
    ]);
    expect(
      radios.filter((el) => el.getAttribute("aria-checked") === "true").map(label)
    ).toEqual(["Fetch all repositories", "Every 5 minutes"]);
    expect(document.querySelector(".pop-menu__heading")?.textContent).toBe(
      "Fetch automatically"
    );
    act(() => radios[3]!.click());
    expect(onPickSync).toHaveBeenCalledWith("pull", "recent");
    // A setting, not a command: the menu is still there for the next one.
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find((el) => el.textContent === "Every hour")!
        .click()
    );
    expect(onPickFetchInterval).toHaveBeenCalledWith(60);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // The chevron closes it.
    act(() => chevron.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(caret()).toBe("m6 9 6 6 6-6");
  });

  it("closes the menu and runs the face when the face is clicked", () => {
    const h = render({ hasProfile: true, rootCount: 1, repoCount: 3 });
    act(() => button("Sync options").click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const face = button("Fetch all repos");
    act(() => {
      face.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      face.click();
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(h.onSync).toHaveBeenCalledTimes(1);
  });

  it("marks the face busy while a run is going, and keeps it clickable", () => {
    const h = render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      syncBusy: true
    });
    const face = button("Fetch all repos");
    expect(face.getAttribute("aria-busy")).toBe("true");
    act(() => face.click());
    expect(h.onSync).toHaveBeenCalledTimes(1);
  });

  it("swaps Pull's arrow for the ring while busy; a circular arrow turns instead", () => {
    render({ hasProfile: true, rootCount: 1, repoCount: 3, syncVerb: "pull", syncBusy: true });
    expect(button("Try pull all").querySelector(".wt-btn__spinner")).not.toBeNull();
  });
});

describe("syncFace", () => {
  it("says what the face does, the schedule, and the last timed result", () => {
    expect(
      syncFace({
        verb: "fetch",
        scope: "recent",
        repoCount: 40,
        recentCount: 1,
        interval: 15,
        busy: false,
        lastAuto: "Last automatic fetch at 2:05 PM: all fetched."
      }).tooltip
    ).toBe(
      "Fetch and prune stale remote-tracking references in the 1 repository in the Focused list; local branches are kept. Fetching automatically every 15 minutes. Last automatic fetch at 2:05 PM: all fetched."
    );
    expect(
      syncFace({ verb: "pull", scope: "all", repoCount: 4, recentCount: 1, interval: 5, busy: false })
        .tooltip
    ).toContain("Pulling automatically every 5 minutes.");
    expect(
      syncFace({ verb: "pull", scope: "all", repoCount: 4, recentCount: 1, interval: 0, busy: true })
    ).toMatchObject({ name: "Try pull all", label: "Pull all", count: 4 });
  });
});

describe("lastRunHint", () => {
  it("says what the last run did, when, and whether the timer ran it", () => {
    const hint = lastRunHint({
      mode: "soft-pull",
      scope: "recent",
      auto: true,
      at: new Date(2026, 9, 29, 14, 5),
      summary: {
        counts: { repos: { success: 20, partial: 9, skipped: 52, failed: 2, cancelled: 0 } },
        results: Array.from({ length: 83 })
      } as unknown as BulkSyncSummary
    });
    expect(hint).toMatch(/^Pulled 29 of 83 repositories · automatic, .+$/);
  });

  it("says when the last run was cancelled", () => {
    const hint = lastRunHint({
      mode: "fetch",
      scope: "all",
      auto: false,
      at: new Date(2026, 9, 29, 14, 5),
      summary: {
        cancelled: true,
        counts: { repos: { success: 3, partial: 0, skipped: 0, failed: 0, cancelled: 80 } },
        results: Array.from({ length: 83 })
      } as unknown as BulkSyncSummary
    });
    expect(hint).toMatch(/^Fetched 3 of 83 repositories · cancelled · \d/);
  });
});
