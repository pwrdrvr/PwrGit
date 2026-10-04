// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { REMOTE_HOVER_DWELL_MS, useReportVisible, VISIBLE_REPORT_DEBOUNCE_MS } from "./visibleWorktrees";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("./pwrgit", () => ({ dispatch }));
let callback: IntersectionObserverCallback;
let root: Root;
let container: HTMLDivElement;
const observe = vi.fn();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const render = (children: React.ReactNode) => {
  act(() => root.render(children));
  return {
    getByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`)!,
    getAllByTestId: (id: string) => [...container.querySelectorAll(`[data-testid="${id}"]`)],
    unmount: () => act(() => root.unmount())
  };
};
const fireEvent = {
  mouseEnter: (el: Element) => act(() => el.dispatchEvent(new MouseEvent("mouseenter"))),
  mouseLeave: (el: Element) => act(() => el.dispatchEvent(new MouseEvent("mouseleave")))
};

function Row({ id }: { id: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useReportVisible(ref, id);
  return <div ref={ref} data-testid={id} />;
}
const intersect = (target: Element, visible: boolean): void => {
  act(() => callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver));
};

describe("visible worktree reporting and remote hover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -1, clientY: -1 }));
    dispatch.mockReset().mockResolvedValue(ok(null));
    observe.mockClear();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) { callback = cb; }
      observe(): void { observe(); }
      unobserve(): void {}
    });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("debounces arrivals but withdraws departing rows immediately during a scroll", async () => {
    const view = render(<><Row id="a" /><Row id="b" /></>);
    intersect(view.getByTestId("a"), true);
    expect(dispatch).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(VISIBLE_REPORT_DEBOUNCE_MS));
    expect(dispatch).toHaveBeenLastCalledWith("worktree:reportVisible", { worktreeIds: ["a"] });
    intersect(view.getByTestId("b"), true);
    intersect(view.getByTestId("a"), false);
    expect(dispatch).toHaveBeenLastCalledWith("worktree:reportVisible", { worktreeIds: ["b"] });
    intersect(view.getByTestId("b"), false);
    expect(dispatch).toHaveBeenLastCalledWith("worktree:reportVisible", { worktreeIds: [] });
  });

  it("sends deliberate hover to the immediate lane and cancels pointer sweeps", async () => {
    const view = render(<Row id="hovered" />);
    const row = view.getByTestId("hovered");
    fireEvent.mouseEnter(row);
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS - 1));
    fireEvent.mouseLeave(row);
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS));
    expect(dispatch).not.toHaveBeenCalledWith("remote:checkSelected", expect.anything());
    fireEvent.mouseEnter(row);
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS));
    expect(dispatch).toHaveBeenLastCalledWith("remote:checkSelected", { worktreeId: "hovered", intent: "hover" });
  });

  it("does not mistake scrolling beneath a stationary pointer for deliberate hover", async () => {
    const view = render(<Row id="hovered" />);
    const row = view.getByTestId("hovered");
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 50 }));
    for (let i = 0; i < 5; i += 1) {
      act(() => document.dispatchEvent(new Event("scroll")));
      act(() => row.dispatchEvent(new MouseEvent("mouseenter", { clientX: 50, clientY: 50 })));
      act(() => row.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 50, bubbles: true })));
      await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS));
    }
    expect(dispatch).not.toHaveBeenCalledWith("remote:checkSelected", expect.anything());
    // Actual movement inside the row re-arms deliberate hover.
    act(() => row.dispatchEvent(new MouseEvent("mousemove", { clientX: 55, clientY: 50, bubbles: true })));
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("remote:checkSelected", { worktreeId: "hovered", intent: "hover" });
  });

  it("cancels a pending deliberate hover when scrolling begins", async () => {
    const view = render(<Row id="hovered" />);
    fireEvent.mouseEnter(view.getByTestId("hovered"));
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS - 1));
    act(() => document.dispatchEvent(new Event("scroll")));
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS));
    expect(dispatch).not.toHaveBeenCalledWith("remote:checkSelected", expect.anything());
  });

  it("deduplicates primary repo and checkout rows and removes reports on lens unmount", async () => {
    const view = render(<><Row id="shared" /><Row id="shared" /></>);
    for (const row of view.getAllByTestId("shared")) intersect(row, true);
    await act(() => vi.advanceTimersByTimeAsync(VISIBLE_REPORT_DEBOUNCE_MS));
    expect(dispatch).toHaveBeenLastCalledWith("worktree:reportVisible", { worktreeIds: ["shared"] });
    fireEvent.mouseEnter(view.getAllByTestId("shared")[0]!);
    await act(async () => view.unmount());
    expect(dispatch).toHaveBeenLastCalledWith("worktree:reportVisible", { worktreeIds: [] });
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS));
    expect(dispatch).not.toHaveBeenCalledWith("remote:checkSelected", expect.anything());
  });

  it("batches a lens change into one withdrawal report and does not reobserve stable rerenders", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `repo-${i}`);
    const children = ids.map((id) => <Row key={id} id={id} />);
    const view = render(<>{children}</>);
    expect(observe).toHaveBeenCalledTimes(120);
    const rows = ids.map((id) => view.getByTestId(id));
    act(() => callback(rows.map((target) => ({ target, isIntersecting: true } as IntersectionObserverEntry)), {} as IntersectionObserver));
    await act(() => vi.advanceTimersByTimeAsync(VISIBLE_REPORT_DEBOUNCE_MS));
    dispatch.mockClear();
    for (let i = 0; i < 10; i += 1) render(<>{ids.map((id) => <Row key={id} id={id} />)}</>);
    await act(() => vi.advanceTimersByTimeAsync(VISIBLE_REPORT_DEBOUNCE_MS));
    expect(dispatch).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledTimes(120);
    await act(async () => view.unmount());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("worktree:reportVisible", { worktreeIds: [] });
  });
});
