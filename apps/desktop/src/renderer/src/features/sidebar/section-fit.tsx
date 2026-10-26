import {
  createContext,
  useContext,
  useLayoutEffect,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from "react";
import { BranchGlyph } from "../../lib/BranchGlyph";
import { ChangeRequestGlyph } from "../../lib/ChangeRequestGlyph";
import { RemoteGlyph } from "../../lib/RemoteGlyph";
import { TagGlyph } from "../../lib/TagGlyph";
import { WorktreeGlyph } from "../../lib/WorktreeGlyph";
import { hoverTooltip, type ViewportTooltip } from "../../lib/useViewportTooltip";

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
    if (child.getClientRects().length === 0) continue;
    const margin = parseFloat(getComputedStyle(child).marginRight) || 0;
    if (child.getBoundingClientRect().right + margin > right + 0.5) return false;
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

/**
 * Whether a single-line, ellipsizing label is drawn whole.
 *
 * Not `scrollWidth > clientWidth`: both are whole pixels, and Chromium
 * ellipsizes text that is 0.3px too wide while both read the same. The text
 * range's own rect is fractional, and it keeps its laid-out width while the
 * box paints an ellipsis over the end, so it sees what they round away.
 */
export function labelIsWhole(el: HTMLElement | null): boolean {
  if (el === null) return true;
  const range = document.createRange();
  range.selectNodeContents(el);
  // jsdom implements Range without layout.
  if (typeof range.getBoundingClientRect !== "function") return true;
  const style = getComputedStyle(el);
  const content =
    el.getBoundingClientRect().width -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0) -
    (parseFloat(style.borderLeftWidth) || 0) -
    (parseFloat(style.borderRightWidth) || 0);
  return range.getBoundingClientRect().width <= content + 0.01;
}

/**
 * The block's re-fit, for the sections that re-render on their own state:
 * `RepoChangeRequestSection` and `RepoRefsSections` hold their lists and
 * counts themselves, so "533" can land after `RepoRow` last rendered.
 */
const RefitSections = createContext<() => void>(() => {});
export const RefitSectionsProvider = RefitSections.Provider;

/** Ask the repository block to re-fit after every render of the caller. */
export function useRefitSections(): void {
  const refit = useContext(RefitSections);
  useLayoutEffect(() => refit());
}

export type SectionKind = "worktrees" | "changeRequests" | "branches" | "tags" | "remotes";

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
  tip: Pick<ViewportTooltip, "show" | "hide" | "hideFrom">,
  text: string,
  step: (typeof SECTION_FIT_STEPS)[number] = "fit-glyphs"
): ReturnType<typeof hoverTooltip> {
  const handlers = hoverTooltip(tip, text);
  const ifStepped =
    <E extends ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>>(
      open: (event: E) => void
    ) =>
    (event: E): void => {
      if (event.currentTarget.closest(`.${step}`) !== null) open(event);
    };
  return {
    ...handlers,
    onMouseEnter: ifStepped(handlers.onMouseEnter),
    onFocus: ifStepped(handlers.onFocus)
  };
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
