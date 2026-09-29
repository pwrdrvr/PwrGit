import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * Step a row down by what fits, instead of by fixed breakpoints.
 *
 * `steps` are class names applied cumulatively to `rowRef`: step 1 adds the
 * first, step 2 the first two, and so on. The CSS for each says what that
 * step gives up (drop the button labels, shorten a chip, hide one). The row
 * takes the first step at which `lastRef` — its last in-flow control — ends
 * inside `boxRef`'s content box (its right padding is not room to spend).
 *
 * Why not container queries: a constant is right for exactly one width of
 * content. The header's fork chip reads `↓25 behind upstream` or
 * `↓125 behind upstream-octo`, and a 680px cut hid it at the stock window
 * width while there was room to spare (Fork Sync, turn 3). Measuring the row
 * itself is right for every content by construction.
 *
 * Everything the steps act on must be rigid (`flex: 0 0 auto`). A shrinkable
 * item never overflows, so the row would read as fitting while that item
 * ellipsized; and even a 1000:1 shrink weight leaks a sub-pixel share that
 * draws an ellipsis. The stepping touches only `classList` and reads layout,
 * so it costs a few synchronous layouts and no React render.
 */
export function useFitLadder(
  rowRef: RefObject<HTMLElement | null>,
  boxRef: RefObject<HTMLElement | null>,
  lastRef: RefObject<HTMLElement | null>,
  steps: readonly string[]
): void {
  useStepLadder(
    rowRef,
    () => {
      const box = boxRef.current;
      const last = lastRef.current;
      if (box === null || last === null) return true;
      const style = getComputedStyle(box);
      const inset =
        (parseFloat(style.paddingRight) || 0) +
        (parseFloat(style.borderRightWidth) || 0);
      return (
        last.getBoundingClientRect().right <=
        box.getBoundingClientRect().right - inset + 0.5
      );
    },
    steps
  );
}

/**
 * The ladder with its own test of "fits". `useFitLadder` asks whether the
 * last control ends inside the box; a row whose one shrinkable item absorbs
 * any shortfall never overflows, so it asks instead whether that item is
 * still whole (a sidebar row's branch name, turn 3e).
 */
export function useStepLadder(
  rowRef: RefObject<HTMLElement | null>,
  fits: () => boolean,
  steps: readonly string[],
  /** What to watch for width changes, when the stepped element is rigid. */
  observe: () => Element | null = () => rowRef.current
): void {
  const key = steps.join(" ");

  const fit = (): void => {
    const row = rowRef.current;
    if (row === null) return;
    const classes = key === "" ? [] : key.split(" ");
    row.classList.remove(...classes);
    for (const step of classes) {
      if (fits()) return;
      row.classList.add(step);
    }
  };

  // After every render: a chip's text, a flash, or a control appearing all
  // change what fits without changing the row's width.
  useLayoutEffect(fit);

  useEffect(() => {
    const watched = observe();
    if (watched === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(watched);
    return () => observer.disconnect();
    // `fit` and `observe` read refs; re-observing on every render would
    // churn the observer for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowRef, key]);
}
