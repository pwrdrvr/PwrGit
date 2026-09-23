import { useEffect, useRef, type RefObject } from "react";

/**
 * Everything tabbable, in DOM order. `tabindex="-1"` is excluded on purpose —
 * it means "focusable, but not a tab stop", which is exactly what roving-focus
 * items inside the dialog use.
 */
const TABBABLE =
  'a[href],area[href],button,input,select,textarea,summary,iframe,object,embed,' +
  '[contenteditable],[tabindex]';

/**
 * Chromium answers this directly. jsdom does not implement `checkVisibility`,
 * and its `offsetParent` is always null (it does no layout) — so the fallback
 * reads the cascade instead, which jsdom does model. Using `offsetParent` here
 * would make the trap match nothing under test while working in the app: the
 * exact split where a bug hides.
 *
 * `visibilityProperty` is not optional. `checkVisibility()` defaults to
 * ignoring `visibility`, so in the app a `visibility: hidden` button answers
 * TRUE (measured) and would sit in the trap's cycle — while the jsdom fallback,
 * which reads the cascade, correctly excludes it. That is the same split again,
 * this time hidden behind a test that only ever exercised `display: none`.
 * `opacity` is deliberately left out: a control faded to 0 mid-transition is
 * still a real control.
 */
function visible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true });
  }
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

type Trap = { containerRef: RefObject<HTMLElement | null> };

/** Every trap currently open, in the order they opened. */
const openTraps: Trap[] = [];

function depth(el: HTMLElement): number {
  let n = 0;
  for (let node = el.parentElement; node !== null; node = node.parentElement) n++;
  return n;
}

/**
 * Which open trap answers this Tab — only ever one.
 *
 * Every trap listens on `window`, and each one used to act on its own: a trap
 * that saw focus outside its container pulled it back in. So with a DialogHost
 * confirm open over PruneWorktreesDialog, a Tab inside the confirm was taken by
 * Prune's trap, which dragged focus behind the confirm to Prune's first stop.
 * Give the confirm a trap too and the two fought over every keypress: focus was
 * pulled out by one and back to an edge by the other, and never reached the
 * confirm's second button.
 *
 * The rule is `useDismissable`'s: the trap holding focus wins, the deepest one
 * when nested containers both hold it, and only focus that is in none of them
 * falls to the newest.
 */
function tabOwner(): Trap | undefined {
  const active = document.activeElement;
  let best: Trap | undefined;
  let bestDepth = -1;
  if (active !== null) {
    for (const trap of openTraps) {
      const root = trap.containerRef.current;
      if (root === null || !root.contains(active)) continue;
      const d = depth(root);
      // >= so a later-opened sibling at equal depth still wins.
      if (d >= bestDepth) {
        best = trap;
        bestDepth = d;
      }
    }
  }
  return best ?? openTraps[openTraps.length - 1];
}

function isStop(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  // tabindex="-1" is focusable but not a tab stop — that is what the roving
  // items inside a dialog's own menu use, and they must not be cycled here.
  if (el.tabIndex < 0 || el.hidden) return false;
  return visible(el);
}

const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/**
 * A scroller Chromium puts in the Tab order by itself, so the arrow keys can
 * scroll it: one that overflows and holds nothing else to focus. Nothing in
 * the markup says so — it has no tabindex, and its `tabIndex` reads -1 — so
 * the TABBABLE selector cannot see it.
 *
 * The trap has to, because it decides where the cycle ends. A trap blind to
 * these wrapped straight past one sitting before a dialog's first control or
 * after its last: DialogHost's facts list, once it grew long enough to scroll,
 * and Bulk Sync's results, which a keyboard user then could not scroll at all.
 *
 * jsdom does no layout, so `scrollHeight` is always 0 there and this never
 * matches under test unless the test supplies the geometry.
 */
function scrollsByKeyboard(el: HTMLElement): boolean {
  if (el.hasAttribute("tabindex")) return false; // judged as an ordinary stop
  const style = getComputedStyle(el);
  const overflowsY = SCROLLS.has(style.overflowY) && el.scrollHeight > el.clientHeight;
  const overflowsX = SCROLLS.has(style.overflowX) && el.scrollWidth > el.clientWidth;
  return overflowsY || overflowsX;
}

/**
 * The dialog's Tab stops, in document order.
 *
 * `scrollers: false` is for initial focus, which belongs on a control even
 * when a scroller comes first — opening Bulk Sync should not park focus on
 * its results list.
 */
function tabbable(
  root: HTMLElement | null,
  { scrollers = true }: { scrollers?: boolean } = {}
): HTMLElement[] {
  if (root === null) return [];
  if (!scrollers) {
    return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(isStop);
  }
  const all = [...root.querySelectorAll<HTMLElement>("*")];
  const stops = new Set(all.filter((el) => el.matches(TABBABLE) && isStop(el)));
  // Innermost first, as Chromium decides it: a scroller holding a stop, even
  // another scroller, is not a stop itself.
  const holders = [...stops];
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]!;
    if (stops.has(el) || !scrollsByKeyboard(el) || !visible(el)) continue;
    if (holders.some((stop) => el.contains(stop))) continue;
    stops.add(el);
    holders.push(el);
  }
  return all.filter((el) => stops.has(el));
}

/**
 * Keeps Tab inside an open modal and restores focus to whatever opened it.
 *
 * A modal that does not trap is a modal in name only: Tab walks out into the
 * page behind it, where a screen-reader or keyboard user then operates controls
 * they cannot see is blocked, with no way back (WCAG 2.1 SC 2.4.3). The app's
 * dialogs were all like this, and five of them could not even be closed with
 * Escape.
 *
 * Escape belongs to `useDismissable`, which every caller of this hook also uses
 * — the two are separate because menus need dismissal without a trap.
 */
export function useFocusTrap({
  open,
  containerRef,
  initialFocusRef
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** Where focus lands on open. Defaults to the first tabbable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}): void {
  // The opener is captured during RENDER, not in the effect below.
  //
  // React applies `autoFocus` while committing, which is before passive effects
  // run — so a dialog with an autoFocused field (most of them) had already
  // moved focus inside itself by the time an effect could look. The hook then
  // recorded that field as the opener and, on close, found it disconnected and
  // restored nothing: focus fell to <body> and the keyboard user was back at
  // the top of the document. Render runs before commit, so this sees the real
  // opener.
  // The `typeof document` guard keeps this render-safe without a DOM:
  // PullDivergenceDialog's tests render the component through
  // `renderToStaticMarkup`, where reading `document` at render time throws.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    openerRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const opener = openerRef.current;
    const target =
      initialFocusRef?.current ?? tabbable(containerRef.current, { scrollers: false })[0];
    // A dialog with nothing tabbable still needs to receive focus, or the first
    // Tab escapes it; the container carries tabindex="-1" for that case.
    (target ?? containerRef.current)?.focus();
    return () => {
      // Only if the dialog still owns focus — a caller that deliberately sent
      // focus somewhere else on close (a field it wants corrected) keeps it.
      const active = document.activeElement;
      const stillInside =
        active === null ||
        active === document.body ||
        containerRef.current?.contains(active) === true;
      if (stillInside && opener !== null && opener.isConnected) opener.focus();
    };
  }, [open, containerRef, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const trap: Trap = { containerRef };
    openTraps.push(trap);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      if (tabOwner() !== trap) return;
      const root = containerRef.current;
      if (root === null) return;
      const list = tabbable(root);
      if (list.length === 0) {
        // Nothing to cycle through: hold focus on the container itself.
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      // Focus outside the dialog entirely (it was moved programmatically, or
      // the browser reset it to <body>) is pulled back to the near edge.
      if (active === null || !root.contains(active)) {
        e.preventDefault();
        const edge = e.shiftKey ? last : first;
        if (active?.closest('[role="menu"]') != null) {
          // A menu portalled out of the dialog (ImageLightbox's copy menu)
          // answers Tab itself: useMenuNavigation closes it, but only while
          // focus is still inside it, and this capture listener runs first.
          // Pulling focus here left the menu open over a dialog whose keys it
          // still owned. So wait until the event has been through the menu's
          // listener, which is a bubble listener on window too, and registered
          // earlier.
          window.addEventListener(
            "keydown",
            (after) => {
              if (after === e && !root.contains(document.activeElement)) edge.focus();
            },
            { once: true }
          );
          return;
        }
        edge.focus();
        return;
      }
      // The container itself: ImageLightbox focuses its frame on open, and a
      // click on any dialog's blank area focuses its tabIndex=-1 container.
      // It is inside, but on no edge, so Shift+Tab used to walk backwards out
      // of the dialog.
      if (active === root) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const at = openTraps.indexOf(trap);
      if (at !== -1) openTraps.splice(at, 1);
    };
  }, [open, containerRef]);
}
