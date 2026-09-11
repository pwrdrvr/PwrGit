import { useEffect, useRef, type RefObject } from "react";

/** Anything `role="menu"` is allowed to own as a focusable child. */
const ITEM_SELECTOR =
  '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/** Typeahead resets once the user stops typing — same idle window as a native menu. */
const TYPEAHEAD_IDLE_MS = 500;

function items(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
    (el) => el.getAttribute("aria-disabled") !== "true" && !el.hasAttribute("disabled")
  );
}

/**
 * The WAI-ARIA menu keyboard contract, for any surface already marked up as
 * `role="menu"` with `menuitem`-ish children.
 *
 * The app had four popup menus wearing `role="menu"` and none of them
 * implementing it — a role is a promise to assistive tech, and a screen-reader
 * user who is told "menu" reaches for the arrow keys. Roving tabindex keeps the
 * menu a single tab stop, which is the other half of that promise: Tab should
 * leave the menu, not walk through it.
 *
 * Focus moves into the menu on open so the arrows have somewhere to start, and
 * so Escape has something meaningful to return. Mouse users are unaffected —
 * `:focus-visible` does not match a pointer-initiated focus, so no ring appears.
 */
export function useMenuNavigation({
  open,
  menuRef,
  onClose
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  /** Called for Tab, which per APG closes the menu and lets focus move on. */
  onClose: () => void;
}): void {
  // Callers routinely pass an inline arrow. Holding it in a ref keeps the
  // keydown subscription from being torn down and rebuilt every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Roving tabindex + initial focus. Runs on every open so a menu whose items
  // changed while closed still starts from a valid one — and again whenever the
  // items change *while* open, which is not hypothetical: `.branch-pop` builds
  // its list from graph data that can arrive after the menu is up, and
  // ContextMenu re-renders its items in place. When the node holding the tab
  // stop unmounts, nothing is left in the tab order and focus drops to <body>,
  // where useDismissable reads the next Escape as "nowhere in particular".
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (menu === null) return;

    /** Put the tab stop on `preferred`, else the checked item, else the first. */
    const seed = (preferred: HTMLElement | null, moveFocus: boolean): void => {
      const list = items(menu);
      if (list.length === 0) return;
      for (const el of list) el.tabIndex = -1;
      // Start on the checked item when there is one: re-opening a menu that
      // records a choice should land on that choice, not on the top of the list.
      const checked = list.find((el) => el.getAttribute("aria-checked") === "true");
      const target = preferred ?? checked ?? list[0]!;
      target.tabIndex = 0;
      if (moveFocus) target.focus();
    };

    seed(null, true);

    // Re-seed only once the menu has actually lost its tab stop. If the user is
    // still standing on an item, the stop follows them rather than snapping
    // back to the top; only a menu that has lost focus altogether takes it back.
    const observer = new MutationObserver(() => {
      const list = items(menu);
      if (list.length === 0) return;
      if (list.some((el) => el.tabIndex === 0 && el.isConnected)) return;
      const active = document.activeElement as HTMLElement | null;
      const held = active !== null && list.includes(active) ? active : null;
      seed(held, held === null && !menu.contains(active));
    });
    observer.observe(menu, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, menuRef]);

  useEffect(() => {
    if (!open) return;
    let typed = "";
    let typedAt = 0;

    const moveTo = (next: HTMLElement, list: HTMLElement[]): void => {
      for (const el of list) el.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    };

    const onKey = (e: KeyboardEvent): void => {
      const menu = menuRef.current;
      if (menu === null) return;
      const list = items(menu);
      if (list.length === 0) return;
      // Only steer while focus is actually in the menu; a global listener must
      // not hijack arrows meant for the list behind an open menu.
      const active = document.activeElement as HTMLElement | null;
      if (active === null || !menu.contains(active)) return;
      const at = list.indexOf(active);

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveTo(list[(at + 1) % list.length]!, list);
          return;
        case "ArrowUp":
          e.preventDefault();
          // `at` is -1 when focus is in the menu but not on an item (the
          // container itself, or an item disabled since it was focused).
          // Without the guard the modulo lands on the second-to-last entry and
          // the last one cannot be reached going up; ArrowDown's `at + 1`
          // happens to give the right answer for -1, which hides the asymmetry.
          moveTo(
            at === -1 ? list[list.length - 1]! : list[(at - 1 + list.length) % list.length]!,
            list
          );
          return;
        case "Home":
          e.preventDefault();
          moveTo(list[0]!, list);
          return;
        case "End":
          e.preventDefault();
          moveTo(list[list.length - 1]!, list);
          return;
        case "Tab":
          // APG: Tab closes the menu and moves on. Escape is `useDismissable`.
          onCloseRef.current();
          return;
        default:
          break;
      }

      // Typeahead: printable single characters only, so modifier chords and
      // named keys ("Enter", "F5") fall through to the browser. Space is
      // excluded explicitly — it is one character long, but it activates the
      // focused item, and letting it into the buffer left a leading space that
      // no label can match until the idle window resets.
      if (e.key.length !== 1 || e.key === " " || e.altKey || e.ctrlKey || e.metaKey) {
        return;
      }
      const now = Date.now();
      typed = now - typedAt > TYPEAHEAD_IDLE_MS ? e.key : typed + e.key;
      typedAt = now;
      const prefix = typed.toLowerCase();
      // Search from the item after the current one so repeating a letter walks
      // through every match rather than sticking on the first.
      const ordered = [...list.slice(at + 1), ...list.slice(0, at + 1)];
      const hit = ordered.find((el) =>
        (el.textContent ?? "").trim().toLowerCase().startsWith(prefix)
      );
      if (hit !== undefined) {
        e.preventDefault();
        moveTo(hit, list);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, menuRef]);
}
