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
    dispatch.mockReset().mockResolvedValue(ok(null));
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) { callback = cb; }
      observe(): void {}
      unobserve(): void {}
    });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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

  it("deduplicates primary repo and checkout rows and removes reports on lens unmount", async () => {
    const view = render(<><Row id="shared" /><Row id="shared" /></>);
    for (const row of view.getAllByTestId("shared")) intersect(row, true);
    await act(() => vi.advanceTimersByTimeAsync(VISIBLE_REPORT_DEBOUNCE_MS));
    expect(dispatch).toHaveBeenLastCalledWith("worktree:reportVisible", { worktreeIds: ["shared"] });
    fireEvent.mouseEnter(view.getAllByTestId("shared")[0]!);
    view.unmount();
    expect(dispatch).toHaveBeenLastCalledWith("worktree:reportVisible", { worktreeIds: [] });
    await act(() => vi.advanceTimersByTimeAsync(REMOTE_HOVER_DWELL_MS));
    expect(dispatch).not.toHaveBeenCalledWith("remote:checkSelected", expect.anything());
  });
});
