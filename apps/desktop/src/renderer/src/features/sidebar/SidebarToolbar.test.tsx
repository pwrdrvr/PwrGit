// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarToolbar, addMenuReasons, fetchFace } from "./SidebarToolbar";

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
    onFetchAll: vi.fn(),
    onPullAll: vi.fn(),
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
  it("keeps the names the old stack used, each containing its visible label", () => {
    render({ hasProfile: true, rootCount: 1, repoCount: 3 });
    const pairs: Array<[string, string]> = [
      ["Fetch all repos", "Fetch all"],
      ["Try pull all", "Pull all"],
      ["Add repositories", "Add"]
    ];
    for (const [name, visible] of pairs) {
      expect(button(name).textContent).toContain(visible);
      expect(name.toLowerCase()).toContain(visible.toLowerCase());
    }
    // Icon-only: the name is the whole label.
    expect(button("Repository maintenance…").textContent).toBe("");
  });

  it("runs Fetch all, Pull all and maintenance from one click each", () => {
    const h = render({ hasProfile: true, rootCount: 1, repoCount: 3 });
    act(() => button("Fetch all repos").click());
    act(() => button("Try pull all").click());
    act(() => button("Repository maintenance…").click());
    expect(h.onFetchAll).toHaveBeenCalledTimes(1);
    expect(h.onPullAll).toHaveBeenCalledTimes(1);
    expect(h.onMaintenance).toHaveBeenCalledTimes(1);
  });

  it("disables Fetch all and Pull all while there is no repository", () => {
    render({ hasProfile: true, rootCount: 0, repoCount: 0 });
    expect(button("Fetch all repos").disabled).toBe(true);
    expect(button("Try pull all").disabled).toBe(true);
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

  it("names the Fetch face after the remembered scope", () => {
    render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      recentCount: 2,
      fetchScope: "recent"
    });
    const face = button("Fetch recent repos");
    expect(face.textContent).toContain("Fetch recent");
    expect(face.disabled).toBe(false);
  });

  it("disables Fetch recent while the Focused list is empty", () => {
    render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      recentCount: 0,
      fetchScope: "recent"
    });
    expect(button("Fetch recent repos").disabled).toBe(true);
    // The chevron still opens, so the scope can be changed back.
    expect(button("Fetch options").disabled).toBe(false);
  });

  it("offers both scopes and every interval as radio entries, and runs the picks", () => {
    const onPickFetchScope = vi.fn();
    const onPickFetchInterval = vi.fn();
    render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      recentCount: 2,
      fetchInterval: 5,
      onPickFetchScope,
      onPickFetchInterval
    });
    const chevron = button("Fetch options");
    act(() => chevron.click());
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    const radios = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ];
    // An entry with a hint stacks label over hint; read the label alone.
    const label = (el: Element): string | null =>
      (el.querySelector(".pop-menu__stack > span:first-child") ?? el).textContent;
    expect(radios.map(label)).toEqual([
      "Fetch all repositories",
      "Fetch recent repositories",
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
    act(() => radios[1]!.click());
    expect(onPickFetchScope).toHaveBeenCalledWith("recent");
    act(() => chevron.click());
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find((el) => el.textContent === "Every hour")!
        .click()
    );
    expect(onPickFetchInterval).toHaveBeenCalledWith(60);
  });

  it("marks the face busy while a fetch runs, and keeps it clickable", () => {
    const h = render({
      hasProfile: true,
      rootCount: 1,
      repoCount: 3,
      fetchBusy: true
    });
    const face = button("Fetch all repos");
    expect(face.getAttribute("aria-busy")).toBe("true");
    act(() => face.click());
    expect(h.onFetchAll).toHaveBeenCalledTimes(1);
  });
});

describe("fetchFace", () => {
  it("says what the face fetches, the schedule, and the last timed result", () => {
    expect(
      fetchFace({
        scope: "recent",
        repoCount: 40,
        recentCount: 1,
        interval: 15,
        busy: false,
        lastAuto: "Last automatic fetch at 2:05 PM: all fetched."
      }).tooltip
    ).toBe(
      "Fetch and prune the 1 repository in the Focused list; local branches are kept Fetching automatically every 15 minutes. Last automatic fetch at 2:05 PM: all fetched."
    );
    expect(
      fetchFace({ scope: "all", repoCount: 4, recentCount: 1, interval: 0, busy: true })
    ).toMatchObject({ name: "Fetch all repos", label: "Fetch all", count: 4 });
  });
});
