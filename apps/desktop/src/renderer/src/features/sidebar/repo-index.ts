/**
 * The sidebar's repository index: a name-only column beside the tree that
 * shows where every repository is and jumps to one. Pure rules here; the
 * component is `RepoIndex.tsx`, the wiring is in `Sidebar.tsx`.
 *
 * Design: `design/Sidebar Repo Index - UX Review.dc.html`, 3a and turn 4.
 */

/** The sidebar's resize bounds (App's `useColumnResize`). The minimum is also
 *  the width the tree is designed to work at, so the index only ever spends
 *  width beyond it. */
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 520;

/** Remembered on/off. On unless turned off. */
export const REPO_INDEX_KEY = "pwrgit.repoIndex";

export type RepoIndexFit =
  | { shown: true; maxWidth: number }
  | { shown: false; reason: "off" | "few" | "narrow" };

/**
 * Whether the index is drawn, and the most width it may take.
 *
 * The index sizes itself to its longest name (`width: max-content`) and is
 * capped at every pixel the sidebar has past the tree's floor. It steps out
 * entirely once that budget is below `minWidth`, the measured width of its
 * shortest useful truncation (`calc(7ch + padding)` in its own font), so the
 * tree is never pushed below the width it is built for.
 */
export function repoIndexFit(input: {
  enabled: boolean;
  repoCount: number;
  sidebarWidth: number;
  minWidth: number;
  treeFloor?: number;
}): RepoIndexFit {
  if (!input.enabled) return { shown: false, reason: "off" };
  // One repository needs no map.
  if (input.repoCount < 2) return { shown: false, reason: "few" };
  const budget = Math.floor(
    input.sidebarWidth - (input.treeFloor ?? SIDEBAR_MIN_WIDTH)
  );
  // An unmeasured width (0 before the first layout) must not flash the index.
  if (input.minWidth <= 0 || budget < input.minWidth) {
    return { shown: false, reason: "narrow" };
  }
  return { shown: true, maxWidth: budget };
}

/** One repository block's box, in px from the top of the list's scrollport. */
export type RepoBlockBox = { id: string; top: number; bottom: number };

export type RepoSpy = { current: string | null; inView: string[] };

/**
 * Which repository the reader is in, and which are on screen.
 *
 * `line` is the top of the readable area: 0 ungrouped, the sticky folder
 * heading's height grouped. Current is the first block whose bottom is below
 * that line, which is the block whose header is stuck there — never "the most
 * visible" one, which flips back and forth across a tall expanded repository.
 * A block hidden under the sticky heading is not in view.
 */
export function spyRepos(
  blocks: readonly RepoBlockBox[],
  viewportHeight: number,
  line = 0
): RepoSpy {
  const edge = line + 1;
  let current: string | null = null;
  const inView: string[] = [];
  for (const block of blocks) {
    if (block.bottom <= edge) continue;
    if (current === null) current = block.id;
    if (block.top < viewportHeight) inView.push(block.id);
  }
  return { current: current ?? blocks.at(-1)?.id ?? null, inView };
}

export function sameSpy(a: RepoSpy, b: RepoSpy): boolean {
  return (
    a.current === b.current &&
    a.inView.length === b.inView.length &&
    a.inView.every((id, i) => id === b.inView[i])
  );
}

/**
 * Where to scroll so a repository's block starts at the top of the readable
 * area, and how much blank tail the list needs for that to be possible.
 *
 * A repository near the end cannot reach the top on its own; rather than land
 * it somewhere in the middle, the list grows exactly the missing height. The
 * tail is dropped once it scrolls out of view (`spacerIsOffscreen`).
 */
export function jumpScrollPlan(input: {
  scrollTop: number;
  /** The block's top, relative to the scrollport's top edge. */
  blockTop: number;
  /** Sticky folder heading height when grouped, else 0. */
  line: number;
  scrollHeight: number;
  clientHeight: number;
  spacerHeight: number;
}): { scrollTop: number; spacerHeight: number } {
  const target = Math.max(0, input.scrollTop + input.blockTop - input.line);
  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight);
  const missing = target - maxScroll;
  return {
    scrollTop: target,
    spacerHeight: missing > 0 ? input.spacerHeight + missing : input.spacerHeight
  };
}

/** The blank tail can go when nothing of it is on screen: removing it then
 *  moves nothing the reader can see. */
export function spacerIsOffscreen(spacerTop: number, viewportBottom: number): boolean {
  return spacerTop >= viewportBottom;
}

/**
 * Typeahead: the next name after `from` (wrapping) that starts with `query`,
 * case-insensitively. A query of one repeated letter cycles through the names
 * starting with it, the way a native list does. -1 when nothing matches.
 */
export function typeaheadIndex(
  names: readonly string[],
  from: number,
  query: string
): number {
  if (query === "" || names.length === 0) return -1;
  const q = query.toLocaleLowerCase();
  const repeated = q.length > 1 && [...q].every((ch) => ch === q[0]);
  const needle = repeated ? q[0]! : q;
  // A fresh multi-letter query may still match the item it started on.
  const start = repeated || q.length === 1 ? from + 1 : from;
  for (let step = 0; step < names.length; step += 1) {
    const i = (((start + step) % names.length) + names.length) % names.length;
    if (names[i]!.toLocaleLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

export function readRepoIndexEnabled(): boolean {
  try {
    return window.localStorage.getItem(REPO_INDEX_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeRepoIndexEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(REPO_INDEX_KEY, enabled ? "1" : "0");
  } catch {
    // ignore private-mode/quota failures
  }
}

/** The Display options entry's second line, when the index is on but not
 *  drawn. A menu item takes no hover, so the reason is spelled here. */
export function repoIndexMenuHint(fit: RepoIndexFit): string | undefined {
  if (fit.shown || fit.reason === "off") return undefined;
  return fit.reason === "narrow"
    ? "Widen the sidebar to show it"
    : "Shown with two or more repositories";
}
