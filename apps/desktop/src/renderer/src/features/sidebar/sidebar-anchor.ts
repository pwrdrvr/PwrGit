import type { SidebarAnchor } from "../../lib/useNavigationHistory";
import { prefersReducedMotion } from "../../lib/reducedMotion";

/**
 * Where the reader's eyes are in the sidebar, and holding them there.
 *
 * Two jobs, one mechanism. Going somewhere from a sidebar row must not move
 * that row under the pointer, even when the jump inserts a ghost row above it
 * or re-ranks Working. Going Back must put the row you left from back where it
 * sat. Both are "keep row K at offset Y from the list's top for a moment",
 * measured by row key rather than by pixel because what sits above the row
 * changes height in between.
 *
 * A row is any element carrying `data-nav-anchor`, `data-wt-id` or
 * `data-repo-id`; the key prefixes which one so ids from two vocabularies
 * cannot collide.
 */

const ANCHOR_SELECTOR = "[data-nav-anchor], [data-wt-id], [data-repo-id]";

/** How long a jump from a sidebar row holds that row still, so re-renders that
 *  arrive a beat later (focus visits re-ranking Working, a repo expanding)
 *  cannot shift it either. Any wheel, key or press in the list ends it. */
export const KEEP_MS = 900;
/** A press this recent caused the selection change being rendered. */
const INTERACTION_MS = 1_200;

type Snapshot = SidebarAnchor & { at: number };
type Pin = SidebarAnchor & {
  until: number;
  /** Back: flash the row and give it focus once it is found. */
  restore: boolean;
  found: boolean;
};

let snapshot: Snapshot | null = null;
let interactionAt = 0;
let pin: Pin | null = null;

export function anchorKeyOf(el: Element): string | null {
  if (!(el instanceof HTMLElement)) return null;
  const nav = el.dataset["navAnchor"];
  if (nav !== undefined) return `nav:${nav}`;
  const wt = el.dataset["wtId"];
  if (wt !== undefined) return `wt:${wt}`;
  const repo = el.dataset["repoId"];
  if (repo !== undefined) return `repo:${repo}`;
  return null;
}

function offsetIn(list: HTMLElement, el: Element): number {
  return el.getBoundingClientRect().top - list.getBoundingClientRect().top;
}

/** Compared, never interpolated into a selector: a key carries whatever
 *  characters a branch or PR key does. */
function findAnchor(list: HTMLElement, key: string): HTMLElement | null {
  for (const el of list.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)) {
    if (anchorKeyOf(el) === key) return el;
  }
  return null;
}

function remember(list: HTMLElement, el: Element): void {
  const key = anchorKeyOf(el);
  if (key === null) return;
  snapshot = { key, offset: offsetIn(list, el), at: Date.now() };
}

/** The topmost row still in view, for a reader who scrolled without acting. */
function firstVisible(list: HTMLElement): Element | null {
  const top = list.getBoundingClientRect().top;
  for (const el of list.querySelectorAll(ANCHOR_SELECTOR)) {
    if (el.getBoundingClientRect().bottom > top) return el;
  }
  return null;
}

/**
 * Follow the reader in `list`: the row last pressed or focused, re-measured as
 * the list scrolls. Returns the teardown.
 */
export function trackSidebarAnchors(list: HTMLElement): () => void {
  const onPress = (event: Event): void => {
    interactionAt = Date.now();
    // A new gesture ends any hold: the reader is driving again.
    pin = null;
    const row = (event.target as Element | null)?.closest?.(ANCHOR_SELECTOR);
    if (row !== null && row !== undefined && list.contains(row)) {
      remember(list, row);
    }
  };
  const onFocus = (event: FocusEvent): void => {
    const row = (event.target as Element | null)?.closest?.(ANCHOR_SELECTOR);
    if (row !== null && row !== undefined) remember(list, row);
  };
  const onUserScroll = (): void => {
    pin = null;
  };
  let frame = 0;
  const onScroll = (): void => {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      const row =
        (snapshot === null ? null : findAnchor(list, snapshot.key)) ??
        firstVisible(list);
      if (row === null) return;
      const key = anchorKeyOf(row);
      if (key === null) return;
      snapshot = { key, offset: offsetIn(list, row), at: snapshot?.at ?? 0 };
    });
  };
  list.addEventListener("pointerdown", onPress, true);
  list.addEventListener("keydown", onPress, true);
  list.addEventListener("focusin", onFocus);
  list.addEventListener("wheel", onUserScroll, { passive: true });
  list.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    window.cancelAnimationFrame(frame);
    list.removeEventListener("pointerdown", onPress, true);
    list.removeEventListener("keydown", onPress, true);
    list.removeEventListener("focusin", onFocus);
    list.removeEventListener("wheel", onUserScroll);
    list.removeEventListener("scroll", onScroll);
  };
}

/** The anchor to record as a place is left. */
export function snapshotSidebarAnchor(): SidebarAnchor | undefined {
  return snapshot === null
    ? undefined
    : { key: snapshot.key, offset: snapshot.offset };
}

/**
 * A selection just changed. When a press in the sidebar caused it, hold the
 * pressed row where it is. A pending Back restore owns the list instead.
 */
export function keepSidebarAnchorForSelection(now: number = Date.now()): void {
  if (pin?.restore === true && pin.until > now) return;
  if (snapshot === null || now - interactionAt > INTERACTION_MS) return;
  pin = {
    key: snapshot.key,
    offset: snapshot.offset,
    until: now + KEEP_MS,
    restore: false,
    found: false
  };
}

/** Back/Forward: put `anchor` back where it was once its row renders. */
export function restoreSidebarAnchor(anchor: SidebarAnchor): void {
  pin = { ...anchor, until: Date.now() + KEEP_MS * 2, restore: true, found: false };
}

/** Whether a hold is in force and has its row, so the caller's own reveal
 *  scroll must stand down rather than undo it. */
export function sidebarAnchorHeld(now: number = Date.now()): boolean {
  return pin !== null && pin.until > now && pin.found;
}

function flash(el: HTMLElement): void {
  if (prefersReducedMotion()) return;
  el.classList.remove("is-nav-flash");
  // Restart the animation when the same row flashes twice in a row.
  void el.offsetWidth;
  el.classList.add("is-nav-flash");
  window.setTimeout(() => el.classList.remove("is-nav-flash"), 950);
}

/**
 * Run after every sidebar render, before paint: scroll `list` so the held row
 * sits at its offset again. Cheap when nothing is held.
 */
export function applySidebarAnchor(
  list: HTMLElement | null,
  now: number = Date.now()
): void {
  if (list === null || pin === null) return;
  if (pin.until <= now) {
    pin = null;
    return;
  }
  const el = findAnchor(list, pin.key);
  if (el === null) return;
  const delta = offsetIn(list, el) - pin.offset;
  if (Math.abs(delta) >= 1) list.scrollTop += delta;
  if (!pin.found && pin.restore) {
    flash(el);
    if (el.hasAttribute("tabindex")) el.focus({ preventScroll: true });
  }
  pin.found = true;
}

/** Test seam: forget everything. */
export function resetSidebarAnchorForTests(): void {
  snapshot = null;
  interactionAt = 0;
  pin = null;
}
