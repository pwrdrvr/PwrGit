import {
  createContext, useCallback, useContext, useLayoutEffect, useRef,
  type ReactElement, type ReactNode, type RefObject
} from "react";
import { BranchGlyph } from "../../lib/BranchGlyph";
import { ChangeRequestGlyph } from "../../lib/ChangeRequestGlyph";
import { RemoteGlyph } from "../../lib/RemoteGlyph";
import { TagGlyph } from "../../lib/TagGlyph";
import { WorktreeGlyph } from "../../lib/WorktreeGlyph";
import { useStepLadder } from "../../lib/useFitLadder";
import { gatedTooltip, type TooltipHandle } from "../../lib/useViewportTooltip";

/**
 * The section headings' ladder, one per repository block (`.repo-sections`
 * in `RepoRow`). Cumulative, in this order; `app.css` says what each gives
 * up. Design: `design/Sidebar Section Headings - UX Review.dc.html`, 3a.
 *
 * - `fit-short`: "Pull requests" becomes "PRs" ("MRs").
 * - `fit-glyphs`: every label becomes its glyph beside its count.
 * - `fit-fold-1..3`: gone, then behind, then ahead fold into a +N chip.
 *
 * The totals, "N failing", the refresh buttons and Recent never step.
 */
export const SECTION_FIT_STEPS = [
  "fit-short",
  "fit-glyphs",
  "fit-fold-1",
  "fit-fold-2",
  "fit-fold-3"
] as const;

/**
 * The repository row's own two steps, taken while its name would be cut:
 * the forge and visibility marks leave, then "279 wts" becomes the worktree
 * glyph and 279. Only then does the name ellipsize. Design: 3d.
 */
export const REPO_ROW_FIT_STEPS = ["rr-no-marks", "rr-short-count"] as const;

/** Every heading row in a repository block. The Worktrees heading predates
 *  `.ref-section__head-wrap` and keeps its own class. */
export const HEADING_ROWS = ".ref-section__head-wrap, .wt-section__head";

/**
 * A heading row fits while every item in it ends inside its content box.
 *
 * Everything in a heading is rigid (`flex: 0 0 auto`), except "on main",
 * which takes leftover room only and so can never overflow. A rigid item
 * that does not fit runs past the box instead of shrinking, which is what
 * this sees. Margin boxes, so a refresh button's negative margin and the
 * chips' trailing gap count the way the flex line counts them.
 */
export function headingRowFits(row: HTMLElement): boolean {
  const style = getComputedStyle(row);
  const right =
    row.getBoundingClientRect().right -
    (parseFloat(style.paddingRight) || 0) -
    (parseFloat(style.borderRightWidth) || 0);
  for (const child of row.children) {
    // `display: none` (a folded chip, a hidden glyph) has no box at all.
    const boxes = child.getClientRects();
    if (boxes.length === 0) continue;
    const margin = parseFloat(getComputedStyle(child).marginRight) || 0;
    // Flex children normally have one box. Reuse it, while keeping the
    // bounding box semantics for a fragmented child.
    const edge = boxes.length === 1 ? boxes[0]!.right : child.getBoundingClientRect().right;
    if (edge + margin > right + 0.5) return false;
  }
  return true;
}

/** The block fits when every heading row in it does. */
export function headingsFit(block: HTMLElement | null): boolean {
  if (block === null) return true;
  for (const row of block.querySelectorAll<HTMLElement>(HEADING_ROWS)) {
    if (!headingRowFits(row)) return false;
  }
  return true;
}

const RefitSections = createContext<() => void>(() => {});
export const RefitSectionsProvider = RefitSections.Provider;

/** Watch the heading's measured content, including labels hidden by a step.
 * Lists, tooltips and roving focus outside the heading do not affect fit. */
export function SectionHeading({
  className = "ref-section__head-wrap",
  children
}: { className?: string; children: ReactNode }): ReactElement {
  const refit = useContext(RefitSections);
  const observer = useRef<MutationObserver | null>(null);
  const watchHeading = useCallback((row: HTMLDivElement | null) => {
    if (row === null) return;
    const changes = new MutationObserver(refit);
    observer.current = changes;
    changes.observe(row, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: ["class", "style", "hidden", "width", "height", "data-rank", "data-fold"]
    });
    refit();
    return () => {
      changes.disconnect();
      observer.current = null;
      refit();
    };
  }, [refit]);
  useLayoutEffect(() => {
    // Sidebar can flush fits for an anchor before the observer callback.
    // The ladder writes its classes outside the observed heading.
    if (observer.current?.takeRecords().length) refit();
  });
  return <div className={className} ref={watchHeading}>{children}</div>;
}

/** One ladder per open repository. Appearance can change the measured text
 * or padding without resizing its block. */
export function useSectionHeadingLadder(
  sections: RefObject<HTMLDivElement | null>,
  block: RefObject<HTMLDivElement | null>,
  expanded: boolean
): () => void {
  const refit = useStepLadder(sections, () => headingsFit(sections.current), SECTION_FIT_STEPS, {
    observe: () => block.current,
    measureOnCommit: false
  });
  const appearance = useRef<MutationObserver | null>(null);
  useLayoutEffect(() => {
    if (!expanded) return;
    const changes = new MutationObserver(refit);
    changes.observe(document.documentElement, { attributeFilter: ["data-sidebar-text", "data-density", "style"] });
    appearance.current = changes;
    return () => {
      changes.disconnect();
      appearance.current = null;
    };
  }, [expanded, refit]);
  useLayoutEffect(() => {
    if (appearance.current?.takeRecords().length) refit();
  });
  return refit;
}

export type SectionKind = "worktrees" | "stacks" | "changeRequests" | "branches" | "tags" | "remotes";

/**
 * The glyph a heading draws at `fit-glyphs`, before its label. Hidden until
 * then, and always `aria-hidden`: the label stays in the button's name,
 * visually hidden, so the name keeps the words. One noun, one drawing — the
 * same marks the rows, the refs browser and the ⌘K palette use.
 */
export function SectionGlyph({ kind }: { kind: SectionKind }): ReactElement {
  return (
    <span className="ref-section__glyph" aria-hidden="true">
      {kind === "worktrees" ? (
        <WorktreeGlyph />
      ) : kind === "stacks" ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <path d="m2 5 6-3 6 3-6 3zM2 8l6 3 6-3M2 11l6 3 6-3" />
        </svg>
      ) : kind === "changeRequests" ? (
        <ChangeRequestGlyph size={12} />
      ) : kind === "branches" ? (
        <BranchGlyph />
      ) : kind === "tags" ? (
        <TagGlyph size={12} />
      ) : (
        <RemoteGlyph />
      )}
    </span>
  );
}

/**
 * A heading's hover card, "Branches · 533", shown only once its block has
 * taken `step` — while the words are on screen the card would repeat them.
 */
export function steppedTooltip(
  tip: TooltipHandle,
  text: string,
  step: (typeof SECTION_FIT_STEPS)[number] = "fit-glyphs"
): ReturnType<typeof gatedTooltip> {
  return gatedTooltip(tip, text, (trigger) => trigger.closest(`.${step}`) !== null);
}

/** One Branches count chip, ranked by how late it folds: 3 (gone) first. */
export type FoldableChip = { rank: 1 | 2 | 3; text: string };

/**
 * The +N chips, one per fold step, each holding what that step has folded
 * away so far. `fit-fold-k` folds every chip ranked above `3 - k`; only the
 * chip for the deepest step taken is shown (`app.css`). A step that folds
 * nothing present draws no chip.
 */
export function foldChips(
  chips: readonly FoldableChip[]
): { step: 1 | 2 | 3; folded: string[] }[] {
  const out: { step: 1 | 2 | 3; folded: string[] }[] = [];
  for (const step of [1, 2, 3] as const) {
    const folded = chips
      .filter((chip) => chip.rank > 3 - step)
      .map((chip) => chip.text);
    if (folded.length > 0) out.push({ step, folded });
  }
  return out;
}
