import { useLayoutEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/** How much of a row's tag chip is on screen: its whole name, the name
 *  ellipsized down to a floor (app.css `.commit-tag--tag.is-squeezed`), or the
 *  mark alone, the name left to the tooltip and to assistive tech. */
export type TagChipFit = "whole" | "squeezed" | "glyph";

/** How much of a row's ref chips are on screen. The first `shown` capped
 *  branch chips render whole; every other chip folds into the "+N" pill.
 *  `squeeze` lets the one remaining chip ellipsize its name down to a floor
 *  (app.css `.ref-chip.is-squeezed`) — the last step before it folds too.
 *  `tag` is the tag chip's step, or null on a row without one. */
export type RefChipFit = {
  shown: number;
  squeeze: boolean;
  tag: TagChipFit | null;
};

/** One measure pass: every capped chip rendered rigid, then the "+N" pill. */
export type RefChipMeasure = {
  /** The strip's width, as the row's flex layout sized it. */
  available: number;
  /** Right edge of each capped chip (with its PR / worktree adornments),
   *  measured from the strip's left edge. */
  slotRights: number[];
  /** The "+N" pill's width, and the strip's gap in front of it. */
  pill: number;
  gap: number;
  /** Every chip on the commit, including those past the cap. */
  total: number;
};

/** The byline yields at 1000× the strip's weight, not infinitely more, so the
 *  strip gives up a fraction of a pixel before the byline is down to its
 *  avatar. */
const SLACK_PX = 0.5;

/** A row with no branch chips: nothing to measure. */
const NO_STRIP: RefChipMeasure = {
  available: 0,
  slotRights: [],
  pill: 0,
  gap: 0,
  total: 0
};

/** The most chips that fit whole, leaving room for "+N" whenever one folds.
 *  The tag chip is measured whole: it gives way only after every branch chip
 *  has folded, so it starts whole whenever the row has one. */
export function fitRefChips(m: RefChipMeasure, hasTag: boolean): RefChipFit {
  const tag = hasTag ? "whole" : null;
  for (let shown = m.slotRights.length; shown >= 1; shown--) {
    const right = m.slotRights[shown - 1] ?? 0;
    const pill = shown < m.total ? m.gap + m.pill : 0;
    if (right + pill <= m.available + SLACK_PX) return { shown, squeeze: false, tag };
  }
  // Not even one fits whole. Ellipsized, the first might: `useRefChipFit`
  // checks it once rendered and folds it when its floor overflows too.
  return m.slotRights.length > 0
    ? { shown: 1, squeeze: true, tag }
    : { shown: 0, squeeze: false, tag };
}

/** One step less when a committed fit still overflows; null at the bottom.
 *  The meta line gives way from its end, as the byline at its tail already
 *  has: whole trailing chips go first, then the last one ellipsizes, then it
 *  folds. Only then does the tag chip, ahead of them on the line, ellipsize
 *  its name, and then drop it for the mark alone. */
export function shedRefChip(fit: RefChipFit): RefChipFit | null {
  if (fit.shown > 1) return { ...fit, shown: fit.shown - 1, squeeze: false };
  if (fit.shown === 1) {
    return fit.squeeze
      ? { ...fit, shown: 0, squeeze: false }
      : { ...fit, shown: 1, squeeze: true };
  }
  if (fit.tag === "whole") return { ...fit, tag: "squeezed" };
  if (fit.tag === "squeezed") return { ...fit, tag: "glyph" };
  return null;
}

function measure(strip: HTMLElement, total: number): RefChipMeasure {
  const box = strip.getBoundingClientRect();
  const slots = [...strip.children];
  // A measure pass always renders the pill, and always last.
  const pill = slots.pop();
  return {
    available: box.width,
    slotRights: slots.map((slot) => slot.getBoundingClientRect().right - box.left),
    pill: pill?.getBoundingClientRect().width ?? 0,
    gap: Number.parseFloat(getComputedStyle(strip).columnGap) || 0,
    total
  };
}

/** Whether anything in the strip runs past its clipped edge. A squeezed group
 *  can shrink below its chip's floor, so this looks one level in as well. */
function stripOverflows(strip: HTMLElement): boolean {
  const edge = strip.getBoundingClientRect().right + SLACK_PX;
  for (const slot of strip.children) {
    if (slot.getBoundingClientRect().right > edge) return true;
    for (const part of slot.children) {
      if (part.getBoundingClientRect().right > edge) return true;
    }
  }
  return false;
}

/** Whether the meta line's last item, the byline, is pushed past the line's
 *  edge. The strip absorbs a shortfall until it has folded to "+N"; past that,
 *  or on a row with no branch chips, this is where a shortfall shows. */
function lineOverflows(line: HTMLElement): boolean {
  const last = line.lastElementChild;
  return (
    last !== null &&
    last.getBoundingClientRect().right > line.getBoundingClientRect().right + SLACK_PX
  );
}

// One ResizeObserver for every row. Its callback refits inside flushSync:
// left to React's default scheduling, the render would land after the frame
// paints, and every step of a live window resize would flash a clipped chip.
const refits = new Map<Element, () => void>();
const widths = new WeakMap<Element, number>();
let observer: ResizeObserver | undefined;
let fontsWatched = false;

function refitAll(targets: Iterable<() => void>): void {
  flushSync(() => {
    for (const refit of targets) refit();
  });
}

function watchWidth(line: Element, refit: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  observer ??= new ResizeObserver((entries) => {
    const due: (() => void)[] = [];
    for (const entry of entries) {
      const width = entry.contentRect.width;
      // Height changes, and the first report after observe(), are not news.
      if (Math.abs(width - (widths.get(entry.target) ?? width)) < SLACK_PX) continue;
      widths.set(entry.target, width);
      const refit = refits.get(entry.target);
      if (refit !== undefined) due.push(refit);
    }
    if (due.length > 0) refitAll(due);
  });
  // Fonts load on first use, so a chip is often first measured in the
  // fallback face; its width changes when Geist Mono arrives.
  if (!fontsWatched && typeof document !== "undefined" && document.fonts !== undefined) {
    fontsWatched = true;
    document.fonts.addEventListener("loadingdone", () => refitAll([...refits.values()]));
  }
  widths.set(line, line.getBoundingClientRect().width);
  refits.set(line, refit);
  observer.observe(line);
  return () => {
    refits.delete(line);
    observer?.unobserve(line);
  };
}

/**
 * Fits a row's ref chips — its branch-chip strip and its tag chip — to the
 * width its meta line leaves them, so neither ever draws part of a chip.
 * Returns null while measuring: the caller then renders the tag chip whole and
 * every capped branch chip plus the "+N" pill, and this settles on a fit in
 * the same commit, before anything paints.
 *
 * `content` is any value whose identity changes when the meta line's contents
 * might have (the row's view model); a new one re-measures. Width changes and
 * font loads re-measure on their own.
 */
export function useRefChipFit(
  lineRef: RefObject<HTMLElement | null>,
  stripRef: RefObject<HTMLElement | null>,
  total: number,
  hasTag: boolean,
  content: unknown
): RefChipFit | null {
  const [settled, setSettled] = useState<{
    fit: RefChipFit;
    content: unknown;
    epoch: number;
  } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const fit =
    settled !== null && settled.content === content && settled.epoch === epoch
      ? settled.fit
      : null;
  const fits = total > 0 || hasTag;

  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!fits || line === null) return;
    const strip = stripRef.current;
    if (fit === null) {
      const measured = strip === null ? NO_STRIP : measure(strip, total);
      setSettled({ fit: fitRefChips(measured, hasTag), content, epoch });
      return;
    }
    // The measure pass predicts the strip; this checks it, and walks the tag
    // chip down once the strip has nothing left to give.
    if (!(strip !== null && stripOverflows(strip)) && !lineOverflows(line)) return;
    const next = shedRefChip(fit);
    if (next !== null) setSettled({ fit: next, content, epoch });
  }, [lineRef, stripRef, fits, fit, total, hasTag, content, epoch]);

  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!fits || line === null) return;
    return watchWidth(line, () => setEpoch((n) => n + 1));
  }, [lineRef, fits]);

  return fit;
}
