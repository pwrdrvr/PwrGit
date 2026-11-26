import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject
} from "react";

const FIT_OVERLAY = "data-fit-overlay";
const FIT_TEXT_COLUMNS = "data-fit-text-columns";

/** State classes that only alter paint, opacity, shadow, or compositor
 *  transforms and never change an element's layout width or height. */
const PAINT_ONLY_CLASSES = new Set([
  "is-nav-flash",
  "is-selected",
  "is-multiselected",
  "holds-selection",
  "is-open",
  "is-dragging",
  "is-drop-target",
  "is-drop-before",
  "is-drop-after",
  "is-pinned",
  "is-focused",
  "is-context-open",
  "is-arrangeable"
]);

/** True when a MutationRecord can change box geometry (ignoring class toggles
 *  that only add/remove paint-only state tokens). */
export function mutationAffectsFit(record: MutationRecord): boolean {
  if (record.type === "attributes" && record.attributeName === "class") {
    const before = new Set((record.oldValue ?? "").split(/\s+/).filter(Boolean));
    const after = new Set(
      record.target instanceof Element
        ? [...record.target.classList]
        : []
    );
    for (const token of before) {
      if (!after.has(token) && !PAINT_ONLY_CLASSES.has(token)) return true;
    }
    for (const token of after) {
      if (!before.has(token) && !PAINT_ONLY_CLASSES.has(token)) return true;
    }
    return false;
  }
  return true;
}

function affectsFit(record: MutationRecord): boolean {
  const { type, target, addedNodes, removedNodes } = record;
  const element = target instanceof Element ? target : target.parentElement;
  // These roots stay out of flow. Their contents can still lay out and paint,
  // and any resulting scrollbar-width change is delivered by ResizeObserver.
  if (element?.closest(`[${FIT_OVERLAY}]`)) return false;
  if (type === "childList") {
    return [...addedNodes, ...removedNodes].some(
      (node) => !(node instanceof Element && node.hasAttribute(FIT_OVERLAY))
    );
  }
  if (!mutationAffectsFit(record)) return false;
  // Only character edits are covered. The owner supplies a different column
  // count whenever the text width changes, and the attribute triggers a fit.
  return type !== "characterData" || !element?.hasAttribute(FIT_TEXT_COLUMNS);
}

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
  const content = useRef<{
    row: HTMLElement | null;
    box: HTMLElement | null;
    last: HTMLElement | null;
    observer: MutationObserver | null;
  } | null>(null);
  const refit = useStepLadder(
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
    steps,
    {
      observe: () => boxRef.current,
      measureOnCommit: false,
      // A fit covers the mutations already in the row, including its own
      // synchronous step writes. Drop those records before observer delivery.
      afterFit: () => {
        content.current?.observer?.takeRecords();
      }
    }
  );

  useLayoutEffect(() => {
    const row = rowRef.current;
    const box = boxRef.current;
    const last = lastRef.current;
    const previous = content.current;
    if (previous?.row === row && previous.box === box && previous.last === last) return;

    previous?.observer?.disconnect();
    let observer: MutationObserver | null = null;
    if (row !== null && box !== null && last !== null) {
      // Watch the actual controls, including child state changes and text
      // hidden by a step. data-mid and data-short supply CSS-generated text.
      // The toolbars' ARIA states change paint and accessible names only.
      observer = new MutationObserver((changes) => {
        // Subtree records survive removal. The childList record on the
        // remaining parent accounts for any change to in-flow content.
        const documentRoot = document.documentElement;
        if (changes.some((change) =>
          (change.target === row || change.target === documentRoot || box.contains(change.target)) &&
          affectsFit(change)
        )) refit();
      });
      const attributes = ["class", "style", "hidden", "width", "height", "data-mid", "data-short", FIT_TEXT_COLUMNS];
      observer.observe(box, {
        subtree: true,
        childList: true,
        characterData: true,
        attributeOldValue: true,
        attributeFilter: attributes
      });
      if (row !== box) observer.observe(row, { attributeOldValue: true, attributeFilter: attributes });
      // An inherited text-size or font change can leave the box width intact.
      observer.observe(document.documentElement, {
        attributeFilter: ["data-sidebar-text", "data-density", "style"]
      });
    }
    content.current = { row, box, last, observer };
    refit();
  });
  useLayoutEffect(() => () => {
    content.current?.observer?.disconnect();
    content.current = null;
  }, []);
}

/** Refit when the measured row's content or size changes. */
export function useContentStepLadder(
  rowRef: RefObject<HTMLElement | null>,
  fits: () => boolean,
  steps: readonly string[],
  {
    content = () => rowRef.current,
    affectsHeight = false
  }: {
    /** The whole measured row if the steps apply to just one of its children. */
    content?: () => HTMLElement | null;
    affectsHeight?: boolean;
  } = {}
): void {
  const observed = useRef<{ row: HTMLElement; observer: MutationObserver } | null>(null);
  const refit = useStepLadder(rowRef, fits, steps, {
    observe: content,
    affectsHeight,
    measureOnCommit: false,
    afterFit: () => {
      // The fit already covered these changes, including its own step writes.
      observed.current?.observer.takeRecords();
    }
  });

  useLayoutEffect(() => {
    const row = steps.length === 0 || rowRef.current === null ? null : content();
    const previous = observed.current;
    if (previous?.row === row) {
      // Ancestor layout effects can flush fits to read final row geometry.
      if (previous.observer.takeRecords().some(mutationAffectsFit)) refit();
      return;
    }

    previous?.observer.disconnect();
    observed.current = null;
    if (row === null) return;
    const observer = new MutationObserver((changes) => {
      if (changes.some(mutationAffectsFit)) refit();
    });
    observer.observe(row, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeOldValue: true,
      attributeFilter: ["class", "style", "hidden", "width", "height"]
    });
    // Inherited text changes can change the fit without resizing the row.
    observer.observe(document.documentElement, {
      attributeFilter: ["data-sidebar-text", "data-density", "style"]
    });
    observed.current = { row, observer };
    refit();
  });
  useLayoutEffect(() => () => {
    observed.current?.observer.disconnect();
    observed.current = null;
  }, []);
}

type Fit = {
  row: HTMLElement;
  steps: readonly string[];
  fits: () => boolean;
  affectsHeight: boolean;
  afterFit: (() => void) | undefined;
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

function fitRows(active: Fit[]): void {
  // Reset every row before the first layout read. At each depth, finish
  // all reads before writing the next step, so nearby rows share a layout.
  const rows = active;
  for (const { row, steps } of rows) clearSteps(row, steps);
  for (let depth = 0; active.length > 0; depth++) {
    const advance = active.filter(({ fits }) => !fits());
    active = [];
    for (const fit of advance) {
      fit.row.classList.add(fit.steps[depth]!);
      if (depth + 1 < fit.steps.length) active.push(fit);
    }
  }
  for (const fit of rows) fit.afterFit?.();
}

/** True when any fit ladder has queued a measurement. */
export function hasPendingFitLadders(): boolean {
  return pending.size > 0;
}

/** Complete the pending fits for a caller reading geometry in a layout effect. */
export function flushFitLadders(): void {
  if (pending.size === 0) return;
  const heightChanging: Fit[] = [];
  const other: Fit[] = [];
  for (const { fit } of pending) {
    if (fit !== null) (fit.affectsHeight ? heightChanging : other).push(fit);
  }
  pending.clear();

  // Worktree badges can wrap when their steps reset. Fit them first so the
  // other rows measure with the final scrollbar width.
  fitRows(heightChanging);
  fitRows(other);
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

/**
 * Settle the rows of a scrollport before a layout effect reads their geometry.
 * A scrollbar can change all their widths before ResizeObserver delivers.
 */
export function useScrollportFitLadders(ref: RefObject<HTMLElement | null>): () => void {
  const lastWidth = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    const scrollport = ref.current;
    if (scrollport === null) {
      flushFitLadders();
      return;
    }

    const queueWidthChanges = (): void => {
      const width = scrollport.clientWidth;
      if (width === lastWidth.current) return;
      lastWidth.current = width;
      for (const [target, ladders] of watched) {
        if (!scrollport.contains(target)) continue;
        for (const ladder of ladders) pending.add(ladder);
      }
    };

    queueWidthChanges();
    if (pending.size === 0) return;
    flushFitLadders();
    // Settling a wrapped row can itself remove a scrollbar. Refit at the
    // new width before the caller uses the heights from the first pass.
    queueWidthChanges();
    flushFitLadders();
  }, [ref]);

  useLayoutEffect(() => {
    const scrollport = ref.current;
    if (scrollport === null || typeof ResizeObserver === "undefined") return;
    // Keep the width current across browser resizes between React commits.
    const observer = new ResizeObserver(flush);
    observer.observe(scrollport);
    return () => {
      observer.disconnect();
      lastWidth.current = undefined;
    };
  }, [ref, flush]);

  return flush;
}

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
  {
    observe = () => rowRef.current,
    affectsHeight = false,
    measureOnCommit = true,
    afterFit
  }: {
    /** What to watch for width changes, when the stepped element is rigid. */
    observe?: () => Element | null;
    /** Fit first when wrapping can change the space taken by a scrollbar. */
    affectsHeight?: boolean;
    /** Disable only when changes that affect the predicate request a fit themselves. */
    measureOnCommit?: boolean;
    /** Runs after the batch has finished writing the row's steps. */
    afterFit?: () => void;
  } = {}
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
    const changed = previous === null || previous.row !== row || previous.steps !== classes;
    if (previous !== null && changed) {
      clearSteps(previous.row, previous.steps);
    }
    ladder.fit =
      row === null || classes.length === 0 ? null : { row, steps: classes, fits, affectsHeight, afterFit };
    watch(ladder, ladder.fit === null ? null : observe());
    if (measureOnCommit || changed) requestFit(ladder);
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
