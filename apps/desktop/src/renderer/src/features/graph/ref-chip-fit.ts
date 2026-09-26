import { useLayoutEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/** How much of a row's branch-chip strip is on screen. The first `shown`
 *  capped chips render whole; every other chip folds into the "+N" pill.
 *  `squeeze` lets the one remaining chip ellipsize its name down to a floor
 *  (app.css `.ref-chip.is-squeezed`) — the last step before it folds too. */
export type RefChipFit = { shown: number; squeeze: boolean };

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

/** The most chips that fit whole, leaving room for "+N" whenever one folds. */
export function fitRefChips(m: RefChipMeasure): RefChipFit {
  for (let shown = m.slotRights.length; shown >= 1; shown--) {
    const right = m.slotRights[shown - 1] ?? 0;
    const pill = shown < m.total ? m.gap + m.pill : 0;
    if (right + pill <= m.available + SLACK_PX) return { shown, squeeze: false };
  }
  // Not even one fits whole. Ellipsized, the first might: `useRefChipFit`
  // checks it once rendered and folds it when its floor overflows too.
  return m.slotRights.length > 0
    ? { shown: 1, squeeze: true }
    : { shown: 0, squeeze: false };
}

/** One step less when a committed fit still overflows; null at the bottom.
 *  Whole trailing chips go first, then the last one ellipsizes, then it folds. */
export function shedRefChip(fit: RefChipFit): RefChipFit | null {
  if (fit.shown > 1) return { shown: fit.shown - 1, squeeze: false };
  if (fit.shown === 1) {
    return fit.squeeze ? { shown: 0, squeeze: false } : { shown: 1, squeeze: true };
  }
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
function overflows(strip: HTMLElement): boolean {
  const edge = strip.getBoundingClientRect().right + SLACK_PX;
  for (const slot of strip.children) {
    if (slot.getBoundingClientRect().right > edge) return true;
    for (const part of slot.children) {
      if (part.getBoundingClientRect().right > edge) return true;
    }
  }
  return false;
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
 * Fits a row's branch-chip strip to the width its meta line leaves it, so the
 * strip never draws part of a chip. Returns null while measuring: the caller
 * then renders every capped chip plus the "+N" pill, and this settles on a fit
 * in the same commit, before anything paints.
 *
 * `content` is any value whose identity changes when the meta line's contents
 * might have (the row's view model); a new one re-measures. Width changes and
 * font loads re-measure on their own.
 */
export function useRefChipFit(
  stripRef: RefObject<HTMLElement | null>,
  total: number,
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

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    if (fit === null) {
      setSettled({ fit: fitRefChips(measure(strip, total)), content, epoch });
      return;
    }
    // The measure pass predicts; this checks. A shrinkable neighbour (the tag
    // chip) takes back width once chips fold, so a predicted fit can overflow.
    if (!overflows(strip)) return;
    const next = shedRefChip(fit);
    if (next !== null) setSettled({ fit: next, content, epoch });
  }, [stripRef, fit, total, content, epoch]);

  const hasStrip = total > 0;
  useLayoutEffect(() => {
    const line = stripRef.current?.parentElement;
    if (!hasStrip || line == null) return;
    return watchWidth(line, () => setEpoch((n) => n + 1));
  }, [stripRef, hasStrip]);

  return fit;
}
