// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoIndex, type RepoIndexGroup } from "./RepoIndex";

let container: HTMLDivElement;
let root: Root;
let list: HTMLDivElement;
/** Each block's top in list coordinates at scrollTop 0, and its height. */
const LAYOUT: Record<string, [number, number]> = {
  atlas: [0, 26],
  beacon: [26, 300],
  cinder: [326, 26],
  delta: [352, 26]
};
const VIEWPORT = 200;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}

/** A fake tree in the list: blocks whose boxes follow `list.scrollTop`. */
function buildTree(): void {
  list = document.createElement("div");
  const tree = document.createElement("div");
  tree.id = "tree";
  list.append(tree);
  Object.defineProperty(list, "clientHeight", { value: VIEWPORT, configurable: true });
  list.getBoundingClientRect = () => rect(0, VIEWPORT);
  for (const [id, [top, height]] of Object.entries(LAYOUT)) {
    const block = document.createElement("div");
    block.className = "repo-block";
    const row = document.createElement("div");
    row.className = "repo-row";
    row.dataset["repoId"] = id;
    block.append(row);
    block.getBoundingClientRect = () => rect(top - list.scrollTop, height);
    tree.append(block);
  }
  container.append(list);
}

const GROUPS: RepoIndexGroup[] = [
  {
    key: "code",
    label: "code",
    entries: [
      { id: "atlas", name: "atlas-api", containsSelection: false },
      { id: "beacon", name: "beacon-web", containsSelection: true }
    ]
  },
  {
    key: "oss",
    label: "oss",
    entries: [
      { id: "cinder", name: "cinder", containsSelection: false },
      { id: "delta", name: "delta-svc", containsSelection: false }
    ]
  }
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  buildTree();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.head.querySelector("style[data-test]")?.remove();
});

function render(onJump: (id: string) => void = () => undefined): HTMLElement {
  const listRef = createRef<HTMLDivElement>();
  (listRef as { current: HTMLDivElement | null }).current = list;
  const host = document.createElement("div");
  container.prepend(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <RepoIndex groups={GROUPS} listRef={listRef} treeId="tree" onJump={onJump} />
    );
  });
  return host.querySelector("nav")!;
}

const item = (nav: HTMLElement, name: string): HTMLButtonElement =>
  [...nav.querySelectorAll("button")].find((b) => b.textContent === name)!;

describe("RepoIndex", () => {
  it("is a labelled nav of buttons, a list per folder, outside the tree", () => {
    const nav = render();
    expect(nav.getAttribute("aria-label")).toBe("Repository index");
    const lists = [...nav.querySelectorAll("ul")];
    expect(lists.map((ul) => ul.getAttribute("aria-label"))).toEqual(["code", "oss"]);
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "atlas-api",
      "beacon-web",
      "cinder",
      "delta-svc"
    ]);
    for (const button of nav.querySelectorAll("button")) {
      expect(button.getAttribute("aria-controls")).toBe("tree");
    }
    expect(list.contains(nav)).toBe(false);
  });

  it("marks the repository whose header is stuck at the top, and the rest in view", () => {
    const nav = render();
    expect(item(nav, "atlas-api").getAttribute("aria-current")).toBe("location");
    expect(item(nav, "beacon-web").className).toContain("is-in-view");
    expect(item(nav, "cinder").className).not.toContain("is-in-view");

    act(() => {
      list.scrollTop = 150;
      list.dispatchEvent(new Event("scroll"));
    });
    expect(item(nav, "atlas-api").hasAttribute("aria-current")).toBe(false);
    expect(item(nav, "beacon-web").getAttribute("aria-current")).toBe("location");
    expect(item(nav, "beacon-web").className).toContain("is-current");
    expect(item(nav, "cinder").className).toContain("is-in-view");
    expect(nav.querySelectorAll("[aria-current]")).toHaveLength(1);
  });

  it("draws the selection's repository apart from the scroll position", () => {
    const nav = render();
    expect(item(nav, "beacon-web").className).toContain("is-selected");
    expect(item(nav, "atlas-api").className).not.toContain("is-selected");
  });

  it("asks the parent to jump on a click", () => {
    const onJump = vi.fn();
    const nav = render(onJump);
    act(() => item(nav, "delta-svc").click());
    expect(onJump).toHaveBeenCalledWith("delta");
  });

  it("is one tab stop, on the current repository, walked with the arrows", () => {
    const nav = render();
    const stops = [...nav.querySelectorAll("button")].filter((b) => b.tabIndex === 0);
    expect(stops.map((b) => b.textContent)).toEqual(["atlas-api"]);

    const key = (target: HTMLElement, k: string): void => {
      act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    };
    act(() => item(nav, "atlas-api").focus());
    key(item(nav, "atlas-api"), "ArrowDown");
    expect(document.activeElement).toBe(item(nav, "beacon-web"));
    key(item(nav, "beacon-web"), "End");
    expect(document.activeElement).toBe(item(nav, "delta-svc"));
    key(item(nav, "delta-svc"), "ArrowDown");
    expect(document.activeElement).toBe(item(nav, "delta-svc"));
    key(item(nav, "delta-svc"), "Home");
    expect(document.activeElement).toBe(item(nav, "atlas-api"));
    key(item(nav, "atlas-api"), "ArrowUp");
    expect(document.activeElement).toBe(item(nav, "atlas-api"));
    // The roving stop follows focus, so Tab back in returns here.
    key(item(nav, "atlas-api"), "ArrowDown");
    expect(item(nav, "beacon-web").tabIndex).toBe(0);
    expect(item(nav, "atlas-api").tabIndex).toBe(-1);
  });

  it("moves to a name by typing its first letters", () => {
    const nav = render();
    act(() => item(nav, "atlas-api").focus());
    act(() => {
      item(nav, "atlas-api").dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", bubbles: true })
      );
    });
    expect(document.activeElement).toBe(item(nav, "delta-svc"));
  });

  it("has a resize grip that stays inside its bounds and resets to natural", () => {
    // The bounds are the column's computed min-width and max-width.
    const style = document.createElement("style");
    style.dataset["test"] = "";
    style.textContent = ".repo-index { min-width: 70px; max-width: 200px; }";
    document.head.append(style);
    const nav = render();
    nav.getBoundingClientRect = () => ({ ...rect(0, 300), width: 100, right: 100 });
    const grip = nav.parentElement!.querySelector<HTMLElement>('[role="separator"]')!;
    expect(grip.getAttribute("aria-label")).toBe("Resize repository index");
    expect(nav.contains(grip)).toBe(false);

    const press = (key: string): void => {
      act(() => {
        grip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    };
    press("ArrowRight");
    expect(nav.style.width).toBe("116px");
    expect(window.localStorage.getItem("pwrgit.repoIndexWidth")).toBe("116");

    nav.getBoundingClientRect = () => ({ ...rect(0, 300), width: 80, right: 80 });
    press("ArrowLeft");
    expect(nav.style.width).toBe("70px");

    act(() => {
      grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(nav.style.width).toBe("");
    expect(window.localStorage.getItem("pwrgit.repoIndexWidth")).toBeNull();
  });
});
