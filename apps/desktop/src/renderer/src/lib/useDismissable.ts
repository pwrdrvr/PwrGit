import { useEffect, useRef, type RefObject } from "react";

type Layer = {
  id: symbol;
  triggerRef: RefObject<HTMLElement | null>;
  surfaceRef?: RefObject<HTMLElement | null>;
  /** Read at dismiss time so a re-rendered callback is never stale. */
  onDismiss: RefObject<() => void>;
};

/** Every overlay currently open, in the order they opened. */
const openOverlays: Layer[] = [];

function depth(el: HTMLElement): number {
  let n = 0;
  for (let node = el.parentElement; node !== null; node = node.parentElement) n++;
  return n;
}

/**
 * Which open overlay owns Escape.
 *
 * **The one holding focus wins**, and open order only breaks ties. Three
 * cheaper rules were tried and are each wrong:
 *
 * - *Listener order.* Every overlay listens on `window`, so `stopPropagation`
 *   has nothing to stop, and `stopImmediatePropagation` only reaches listeners
 *   registered after this one — the wrong way round for a menu opened inside an
 *   already-open dialog.
 * - *Open order alone.* React runs child effects before parent effects, so two
 *   overlays mounting in one commit register innermost-FIRST; a nested pair
 *   open on first paint would hand Escape to the outer one.
 * - *The last layer that contains focus.* Nested overlays BOTH contain it — the
 *   outer wraps the inner — so containment alone picks whichever registered
 *   last. Depth is what distinguishes them.
 *
 * Focus also survives portals, which containment and depth do not on their own:
 * `WorktreeMenu` renders into `document.body`, far from its logical parent, but
 * it is still the surface holding focus.
 */
function escapeOwner(): Layer | undefined {
  const active = document.activeElement;
  if (active !== null) {
    let best: Layer | undefined;
    let bestDepth = -1;
    for (const layer of openOverlays) {
      const surface = layer.surfaceRef?.current;
      if (surface === undefined || surface === null) continue;
      if (!surface.contains(active)) continue;
      const d = depth(surface);
      // >= so a later-opened sibling at equal depth still wins.
      if (d >= bestDepth) {
        best = layer;
        bestDepth = d;
      }
    }
    if (best !== undefined) return best;
  }
  return openOverlays[openOverlays.length - 1];
}

/**
 * One listener for every overlay, rather than one per hook instance.
 *
 * Per-instance listeners cannot work here: they all fire for the same keypress,
 * and dismissing the owner moves focus, so a listener running afterwards
 * recomputes a *different* owner and dismisses that too — one Escape closing a
 * menu and the dialog behind it. Resolving the owner once per event is the
 * whole point.
 */
function onGlobalKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  const owner = escapeOwner();
  if (owner === undefined) return;
  e.preventDefault();
  restoreFocus(owner.triggerRef, owner.surfaceRef);
  owner.onDismiss.current();
}

function register(layer: Layer): void {
  if (openOverlays.length === 0) {
    window.addEventListener("keydown", onGlobalKeyDown);
  }
  openOverlays.push(layer);
}

function unregister(layer: Layer): void {
  const at = openOverlays.indexOf(layer);
  if (at !== -1) openOverlays.splice(at, 1);
  if (openOverlays.length === 0) {
    window.removeEventListener("keydown", onGlobalKeyDown);
  }
}

/**
 * Escape-dismisses an open overlay and hands focus back to the control that
 * opened it.
 *
 * Every click-opened surface in the app owes this (WCAG 2.1 SC 2.1.1: anything
 * operable by pointer must be operable by keyboard), and before this hook each
 * one either hand-rolled it or silently skipped it — `.branch-pop` and the
 * sidebar options menu could not be closed from the keyboard at all.
 * `useViewportTooltip` is the hover-opened equivalent and predates this; the
 * focus rule below is deliberately the same one it already applies.
 *
 * **Focus is returned only when it was inside the overlay** (or still on the
 * trigger). An overlay can be dismissed while the user is typing somewhere
 * else entirely — a background refresh closing it, say — and yanking the caret
 * out of their text field would be worse than the problem this fixes.
 */
export function useDismissable({
  open,
  onDismiss,
  triggerRef,
  surfaceRef
}: {
  open: boolean;
  onDismiss: () => void;
  /** The control that opened the overlay; focus returns here. */
  triggerRef: RefObject<HTMLElement | null>;
  /** The overlay itself. Focus is only restored if it currently sits inside. */
  surfaceRef?: RefObject<HTMLElement | null>;
}): void {
  // Held in a ref so re-registering is never needed just because the caller
  // passed a fresh closure — re-registering would reorder the stack.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const layer: Layer = {
      id: Symbol("overlay"),
      triggerRef,
      onDismiss: onDismissRef,
      ...(surfaceRef === undefined ? {} : { surfaceRef })
    };
    register(layer);
    return () => unregister(layer);
  }, [open, triggerRef, surfaceRef]);
}

/**
 * Hand focus back to the trigger, but only if the overlay currently owns it.
 * Exported because dismissal paths other than Escape (an item activating, a
 * backdrop click) need the same rule.
 */
export function restoreFocus(
  triggerRef: RefObject<HTMLElement | null>,
  surfaceRef?: RefObject<HTMLElement | null>
): void {
  const active = document.activeElement;
  const trigger = triggerRef.current;
  if (trigger === null) return;
  const inside =
    active === trigger ||
    (active !== null && surfaceRef?.current?.contains(active) === true);
  if (inside) trigger.focus();
}
