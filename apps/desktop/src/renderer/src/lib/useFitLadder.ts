import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject
} from "react";

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
 * draws an ellipsis.
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

type Fit = {
  row: HTMLElement;
  steps: readonly string[];
  fits: () => boolean;
};

type Ladder = {
  fit: Fit | null;
  watched: Element | null;
};

const pending = new Set<Ladder>();
let flushQueued = false;

function clearSteps(row: HTMLElement, steps: readonly string[]): void {
  // Even removing absent tokens can write the class attribute.
  if (steps.some((step) => row.classList.contains(step))) {
    row.classList.remove(...steps);
  }
}

/** Complete the pending fits for a caller reading geometry in a layout effect. */
export function flushFitLadders(): void {
  if (pending.size === 0) return;
  let active: Fit[] = [];
  for (const { fit } of pending) {
    if (fit !== null) active.push(fit);
  }
  pending.clear();

  // Reset every row before the first layout read. At each depth, finish
  // all reads before writing the next step, so nearby rows share a layout.
  for (const { row, steps } of active) clearSteps(row, steps);
  for (let depth = 0; active.length > 0; depth++) {
    const advance = active.filter(({ fits }) => !fits());
    active = [];
    for (const fit of advance) {
      fit.row.classList.add(fit.steps[depth]!);
      if (depth + 1 < fit.steps.length) active.push(fit);
    }
  }
}

function requestFit(ladder: Ladder): void {
  if (ladder.fit === null) return;
  pending.add(ladder);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    flushFitLadders();
  });
}

const watched = new Map<Element, Set<Ladder>>();
let resizeObserver: ResizeObserver | null = null;

function onFontsLoaded(): void {
  for (const ladders of watched.values()) {
    for (const ladder of ladders) pending.add(ladder);
  }
  flushFitLadders();
}

function watch(ladder: Ladder, target: Element | null): void {
  const previous = ladder.watched;
  if (previous === target) return;

  if (watched.size === 0) {
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((entries) => {
        for (const { target } of entries) {
          for (const ladder of watched.get(target) ?? []) pending.add(ladder);
        }
        // Resize deliveries already run as a batch before paint.
        flushFitLadders();
      });
    }
    // A late face changes content widths even when the observed box stays put.
    document.fonts?.addEventListener?.("loadingdone", onFontsLoaded);
  }
  if (previous !== null) {
    const ladders = watched.get(previous)!;
    ladders.delete(ladder);
    if (ladders.size === 0) {
      watched.delete(previous);
      resizeObserver?.unobserve(previous);
    }
  }
  ladder.watched = target;
  if (target !== null) {
    let ladders = watched.get(target);
    if (ladders === undefined) {
      ladders = new Set();
      watched.set(target, ladders);
      resizeObserver?.observe(target);
    }
    ladders.add(ladder);
  }
  if (watched.size === 0) {
    resizeObserver?.disconnect();
    resizeObserver = null;
    document.fonts?.removeEventListener?.("loadingdone", onFontsLoaded);
  }
}

/**
 * The ladder with its own test of "fits". `useFitLadder` asks whether the
 * last control ends inside the box; a row whose one shrinkable item absorbs
 * any shortfall never overflows, so it asks instead whether that item is
 * still whole (a sidebar row's branch name, turn 3e).
 *
 * Returns a stable re-fit, for content the hook cannot see change: a child
 * component that re-renders on its own state (the sidebar's section
 * headings, whose counts land after the repository row has rendered) calls it
 * from its own layout effect. That request joins any fit requested by the
 * parent commit. The fit batch runs in a microtask before paint, or earlier
 * if a layout effect needs the final geometry. Each predicate reads its own
 * row or block.
 */
export function useStepLadder(
  rowRef: RefObject<HTMLElement | null>,
  fits: () => boolean,
  steps: readonly string[],
  /** What to watch for width changes, when the stepped element is rigid. */
  observe: () => Element | null = () => rowRef.current
): () => void {
  const key = steps.join(" ");
  const classes = useMemo(() => (key === "" ? [] : key.split(" ")), [key]);
  const state = useRef<Ladder>({ fit: null, watched: null });

  // A chip's text or a control appearing changes what fits without changing
  // the row's width. Publish the latest predicate only once React commits it.
  useLayoutEffect(() => {
    const ladder = state.current;
    const row = rowRef.current;
    const previous = ladder.fit;
    if (previous !== null && (previous.row !== row || previous.steps !== classes)) {
      clearSteps(previous.row, previous.steps);
    }
    ladder.fit = row === null || classes.length === 0 ? null : { row, steps: classes, fits };
    watch(ladder, ladder.fit === null ? null : observe());
    requestFit(ladder);
  });
  useLayoutEffect(() => {
    const ladder = state.current;
    return () => {
      pending.delete(ladder);
      watch(ladder, null);
      ladder.fit = null;
    };
  }, []);

  return useCallback(() => requestFit(state.current), []);
}
