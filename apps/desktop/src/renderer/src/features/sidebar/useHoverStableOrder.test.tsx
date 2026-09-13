// @vitest-environment jsdom

import { act, StrictMode } from "react";
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

/** A drag event from a row, which bubbles to the list the way a real one does. */
const drag = (type: string): void => {
  const row = container.querySelector(".row");
  act(() => {
    row?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
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

  it("drops a row that left the list instead of holding a ghost", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    render({ ids: ["c", "a"] });
    expect(rows()).toEqual(["a", "c"]);
  });

  // Chromium fires dragstart → pointercancel → pointerout → pointerleave on the
  // container the moment a row is picked up. Releasing on that leave re-sorts
  // the rows the drag is aimed at, mid-gesture.
  it("keeps holding through a drag, which leaves without leaving", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    drag("dragstart");
    pointer("pointercancel");
    pointer("pointerout", { relatedTarget: document.body });
    render({ ids: ["c", "b", "a"] });
    expect(rows()).toEqual(["a", "b", "c"]);
  });

  it("re-freezes against the committed order once the drag ends", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    drag("dragstart");
    pointer("pointerout", { relatedTarget: document.body });
    // The row's own drop handler stops propagation, so the commit — not the
    // container — is what releases. The caller then applies the new order
    // optimistically, and dragend fires pointerover with no user movement.
    act(() => {
      container.querySelector<HTMLButtonElement>(".release")?.click();
    });
    render({ ids: ["c", "a", "b"] });
    drag("dragend");
    pointer("pointerover");
    render({ ids: ["c", "a", "b"] });
    expect(rows()).toEqual(["c", "a", "b"]);
  });

  it("really does leave once the pointer leaves after a drag", () => {
    render({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    drag("dragstart");
    drag("dragend");
    pointer("pointerout", { relatedTarget: document.body });
    render({ ids: ["c", "b", "a"] });
    expect(rows()).toEqual(["c", "b", "a"]);
  });

  // main.tsx mounts the app in StrictMode, so every render runs twice and the
  // hook's mid-render ref writes run twice with it.
  it("holds the same order through StrictMode's double render", () => {
    const strict = (props: Parameters<typeof List>[0]): void => {
      act(() =>
        root.render(
          <StrictMode>
            <List {...props} />
          </StrictMode>
        )
      );
    };
    strict({ ids: ["a", "b", "c"] });
    pointer("pointerover");
    strict({ ids: ["c", "b", "a"] });
    expect(rows()).toEqual(["a", "b", "c"]);
    strict({ ids: ["c", "b", "a"], scope: "All" });
    expect(rows()).toEqual(["c", "b", "a"]);
  });
});
