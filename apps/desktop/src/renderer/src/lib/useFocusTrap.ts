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
 */
function visible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function tabbable(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    // tabindex="-1" is focusable but not a tab stop — that is what the roving
    // items inside a dialog's own menu use, and they must not be cycled here.
    if (el.tabIndex < 0 || el.hidden) return false;
    return visible(el);
  });
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
    const target = initialFocusRef?.current ?? tabbable(containerRef.current)[0];
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
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
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
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, containerRef]);
}
