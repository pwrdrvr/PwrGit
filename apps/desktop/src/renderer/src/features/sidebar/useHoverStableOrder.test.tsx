// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useHoverStableOrder } from "./useHoverStableOrder";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function List({
  ids,
  scope = "Focused",
  context = "live"
}: {
  ids: string[];
  scope?: string;
  context?: string;
}) {
  const stable = useHoverStableOrder({ scope, ids, context });
  return (
    <div className="list" {...stable.containerProps}>
      <span className="context">{stable.context}</span>
      <button type="button" className="release" onClick={stable.release}>
        release
      </button>
      {stable.ids.map((id) => (
        <div className="row" key={id} data-id={id} />
      ))}
    </div>
  );
}

const render = (props: Parameters<typeof List>[0]): void => {
  act(() => root.render(<List {...props} />));
};

const rows = (): string[] =>
  [...container.querySelectorAll(".row")].map(
    (row) => row.getAttribute("data-id") ?? ""
  );

const shownContext = (): string =>
  container.querySelector(".context")?.textContent ?? "";

const pointer = (type: string, init: PointerEventInit = {}): void => {
  const row = container.querySelector(".row") ?? container.querySelector(".list");
  act(() => {
    row?.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType: "mouse", ...init })
    );
  });
};

describe("useHoverStableOrder", () => {
  it("shows the newest order while the pointer is away", () => {
    render({ ids: ["a", "b", "c"] });
    render({ ids: ["c", "b", "a"] });
    expect(rows()).toEqual(["c", "b", "a"]);
  });

  it("holds the order the pointer arrived on", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    render({ ids: ["c", "b", "a"] });
    expect(rows()).toEqual(["a", "b", "c"]);
  });

  it("lands a newcomer at the bottom instead of under the pointer", () => {
    render({ ids: ["a", "b"] });
    pointer("pointerover");
    render({ ids: ["new", "a", "b"] });
    expect(rows()).toEqual(["a", "b", "new"]);
  });

  it("holds the ordering context, so downstream sections freeze with it", () => {
    render({ ids: ["a"], context: "before-click" });
    pointer("pointerover");
    render({ ids: ["a"], context: "after-click" });
    expect(shownContext()).toBe("before-click");
  });

  it("catches up the moment the pointer leaves", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    render({ ids: ["c", "b", "a"] });
    // React synthesizes onPointerLeave from the bubbling pointerout, which is
    // what a real pointer moving off the list emits.
    pointer("pointerout", { relatedTarget: document.body });
    expect(rows()).toEqual(["c", "b", "a"]);
    expect(shownContext()).toBe("live");
  });

  it("catches up when the pointer is cancelled out from under it", () => {
    render({ ids: ["a", "b"] });
    pointer("pointerover");
    render({ ids: ["b", "a"] });
    pointer("pointercancel");
    expect(rows()).toEqual(["b", "a"]);
  });

  it("catches up on release, so a drag-reorder is not undone", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    render({ ids: ["b", "a", "c"] });
    expect(rows()).toEqual(["a", "b", "c"]);
    act(() => {
      container.querySelector<HTMLButtonElement>(".release")?.click();
    });
    expect(rows()).toEqual(["b", "a", "c"]);
  });

  it("switching lens under the pointer shows the new lens, not the old order", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    render({ ids: ["c", "b", "a"], scope: "All" });
    expect(rows()).toEqual(["c", "b", "a"]);
  });

  it("never freezes for touch, which has no hover to rest in", () => {
    render({ ids: ["a", "b"] });
    pointer("pointerover", { pointerType: "touch" });
    render({ ids: ["b", "a"] });
    expect(rows()).toEqual(["b", "a"]);
  });
});
