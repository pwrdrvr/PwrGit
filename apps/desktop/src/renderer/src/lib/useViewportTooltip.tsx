import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

const VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 8;
const INTERACTIVE_DISMISS_DELAY_MS = 400;
/** When a pointer is near a graph edge, spill the card into its adjacent pane
 * instead of covering the commit list. */
const EDGE_SPILL_ZONE = 160;

export type TooltipAnchor = { x: number; y: number };
export type TooltipRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type TooltipState = {
  content: ReactNode;
  targetRect: TooltipRect;
  anchor?: TooltipAnchor;
  left?: number;
  top?: number;
};

export type ViewportTooltip = {
  show: (
    target: HTMLElement,
    content: ReactNode,
    anchor?: TooltipAnchor
  ) => void;
  /** Replace an open tooltip's content without making it blink. */
  update: (content: ReactNode) => void;
  hide: () => void;
  /**
   * Leave a trigger, restoring the enclosing trigger's card when the pointer
   * has only moved out to it. Hover targets nest — a file row carries one card
   * and the path inside it carries another — and React fires no `mouseenter`
   * on an ancestor you never left, so a plain `hide()` there leaves the
   * pointer sitting on a trigger with nothing shown. A native `title` put the
   * ancestor's back.
   */
  hideFrom: (event: {
    relatedTarget: EventTarget | null;
  }) => void;
  /** Delay dismissal long enough to cross from a hover target into a card. */
  scheduleHide: () => void;
  /**
   * Hold this card open regardless of the pointer.
   *
   * A hover card belongs to the pointer: leaving it, or scrolling the surface
   * it described, is the dismissal. A card the user *clicked* open belongs to
   * them until they say otherwise, so while sticky both of those become
   * no-ops and only an explicit exit — Escape, a control inside it, the
   * caller's own dismissal — takes it away. `hide()` always wins, and clears
   * the flag with it.
   */
  setSticky: (sticky: boolean) => void;
  /**
   * Move keyboard focus into an open tooltip's first control — or, where the
   * content marks one `data-focus-first`, into that one instead.
   *
   * The marker exists because "first in the DOM" and "what the user came for"
   * diverged the moment a card grew a dismiss ✕ in its header: Tab landed on
   * "get rid of this" rather than on Cancel, which is the control a wedged
   * fetch is being tabbed into for. Reordering the DOM to fix it would put the
   * focus order out of step with the visual one (SC 2.4.3); saying which
   * control matters does not.
   */
  focusFirst: () => boolean;
  visible: boolean;
  tooltipNode: ReactNode;
};

/**
 * The handlers that make any element open a card on hover AND on focus.
 *
 * One spelling, in one place, because the two halves are not optional
 * separately: a mark that opens on hover but not on focus is a mark a keyboard
 * user never sees, and every copy of this that drifts loses one of them. This
 * is also the whole replacement for a native `title`, which was pointer-only —
 * so the focus half is the entire point of routing through a helper rather
 * than writing four props at each call site.
 *
 * ```tsx
 * const tip = useViewportTooltip();
 * <button {...hoverTooltip(tip, "Fetch all remotes")}>…</button>
 * {tip.tooltipNode}
 * ```
 *
 * Pass the tooltip a component already owns; this adds no state of its own.
 * One hook and one `tooltipNode` per component, however many triggers it has —
 * a list shares one card the way `LineageGraph` shares one `HoverIntent`.
 *
 * `content` may be `undefined`, which is what call sites pass when there is
 * conditionally nothing to say (`title={x ? y : undefined}` was the shape).
 * The handlers then do nothing rather than opening an empty card.
 *
 * Not for a trigger that should be gated on dwell — see `hoverIntentHandlers`
 * and "Which hover popups are gated" in this directory's AGENTS.md.
 */
export function hoverTooltip(
  tip: Pick<ViewportTooltip, "show" | "hide" | "hideFrom">,
  content: ReactNode
): {
  onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => void;
  onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
  onBlur: () => void;
} {
  // `null` and `false` are legitimate ReactNodes that render nothing, so they
  // count as empty alongside `undefined` and "". A node that renders nothing
  // would otherwise open a bordered, padded, empty box.
  const empty =
    content === undefined ||
    content === null ||
    content === false ||
    content === "";
  // Read `currentTarget` synchronously into the call: React nulls it once the
  // handler returns, and `show` stores that element to return focus to.
  const open = (
    event: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>
  ): void => {
    if (empty) return;
    tip.show(event.currentTarget, content);
  };
  return {
    onMouseEnter: open,
    // Not `tip.hide`: leaving an inner trigger for the row around it has to
    // put the row's own card back. See `hideFrom`.
    onMouseLeave: tip.hideFrom,
    onFocus: open,
    onBlur: tip.hide
  };
}

type ViewportTooltipOptions = {
  /** Interactive cards remain open while the pointer moves from their target. */
  interactive?: boolean;
  /**
   * Accessible name for an interactive card. Every consumer names the thing it
   * is actually showing: this hook serves the commit card and the PR/MR card,
   * so a hard-coded name would mis-announce one of them.
   */
  label?: string;
  /**
   * The pointer entered or left an interactive card.
   *
   * Reported by the hook rather than by handlers on the caller's own content
   * because the card's padding belongs to the surface, not to the content
   * inside it: a pointer resting in that ring is on the card by every reading
   * a user would give it, and handlers on the content alone would say it had
   * left. The remote-activity popover pauses its countdown on this.
   */
  onPointerWithin?: (within: boolean) => void;
};

type TooltipPlacement = {
  target: TooltipRect;
  tooltip: { width: number; height: number };
  viewport: { width: number; height: number };
  anchor?: TooltipAnchor;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Calculate a portalled tooltip's viewport-relative position. Pointer-anchored
 * cards stay close to the cursor, but spill into a sidebar when the cursor is
 * close to the graph's left or right edge. */
export function placeViewportTooltip({
  target,
  tooltip,
  viewport,
  anchor
}: TooltipPlacement): { left: number; top: number } {
  const maxLeft = Math.max(
    VIEWPORT_PADDING,
    viewport.width - tooltip.width - VIEWPORT_PADDING
  );
  const maxTop = Math.max(
    VIEWPORT_PADDING,
    viewport.height - tooltip.height - VIEWPORT_PADDING
  );
  const clampLeft = (left: number): number =>
    clamp(left, VIEWPORT_PADDING, maxLeft);
  const clampTop = (top: number): number =>
    clamp(top, VIEWPORT_PADDING, maxTop);

  // Generic tooltips retain the original target-centred behavior.
  if (anchor === undefined) {
    const left = clampLeft(
      (target.left + target.right) / 2 - tooltip.width / 2
    );
    const top =
      target.top - tooltip.height - TOOLTIP_GAP >= VIEWPORT_PADDING
        ? target.top - tooltip.height - TOOLTIP_GAP
        : target.bottom + TOOLTIP_GAP;
    return { left, top: clampTop(top) };
  }

  const leftDistance = anchor.x - target.left;
  const rightDistance = target.right - anchor.x;
  const nearerEdge = leftDistance <= rightDistance ? "left" : "right";
  const edgeDistance =
    nearerEdge === "left" ? leftDistance : rightDistance;
  let left: number;

  if (edgeDistance <= EDGE_SPILL_ZONE) {
    // A graph row lives only in the centre pane. Place a nearby card outside
    // it, over the left/right pane, so it does not hide neighbouring commits.
    left =
      nearerEdge === "left"
        ? target.left - tooltip.width - TOOLTIP_GAP
        : target.right + TOOLTIP_GAP;
  } else {
    // Away from the edges, sit immediately beside the pointer and choose the
    // side with enough room. This minimizes eye/mouse travel in the list.
    const toRight = anchor.x + TOOLTIP_GAP;
    const toLeft = anchor.x - tooltip.width - TOOLTIP_GAP;
    const rightFits = toRight + tooltip.width <= viewport.width - VIEWPORT_PADDING;
    const leftFits = toLeft >= VIEWPORT_PADDING;
    left = rightFits || !leftFits ? toRight : toLeft;
  }

  const below = anchor.y + TOOLTIP_GAP;
  const above = anchor.y - tooltip.height - TOOLTIP_GAP;
  const top =
    below + tooltip.height <= viewport.height - VIEWPORT_PADDING || above < VIEWPORT_PADDING
      ? below
      : above;
  return { left: clampLeft(left), top: clampTop(top) };
}

const rectOf = (rect: DOMRect): TooltipRect => ({
  left: rect.left,
  right: rect.right,
  top: rect.top,
  bottom: rect.bottom
});

/**
 * A hover/focus tooltip rendered into a portal so it escapes clipping
 * ancestors. Pointer-anchored callers get a card beside the cursor; generic
 * callers retain target-centred placement. Interactive cards give the pointer
 * a brief grace period to cross into the card and keep their first placement
 * through content updates. Dismisses on window blur or any scroll. Callers
 * own show/hide and render `tooltipNode`. Content can be a structured card,
 * not just a text string.
 */
export function useViewportTooltip(
  className = "viewport-tooltip",
  {
    interactive = false,
    label = "Commit context",
    onPointerWithin
  }: ViewportTooltipOptions = {}
): ViewportTooltip {
  const tooltipRef = useRef<HTMLDivElement>(null);
  /** The element this tooltip was opened from, for returning focus. */
  const targetRef = useRef<HTMLElement | null>(null);
  /** A trigger whose tooltip Escape dismissed, until the pointer or focus
   * leaves it. Without this the card reopens the instant focus returns. */
  const dismissedTargetRef = useRef<HTMLElement | null>(null);
  /** What each trigger last showed, so leaving a nested trigger can restore
   *  the enclosing one. Weak so a removed row is not held alive by it. */
  const contentByTargetRef = useRef(new WeakMap<HTMLElement, ReactNode>());
  const dismissTimerRef = useRef<number | undefined>(undefined);
  const pointerInInteractiveTooltipRef = useRef(false);
  /** Set by `setSticky`; read by the two dismissals the pointer owns. */
  const stickyRef = useRef(false);
  // Latched: the caller passes a fresh closure every render, and the only
  // things that read it are event handlers registered once.
  const onPointerWithinRef = useRef(onPointerWithin);
  onPointerWithinRef.current = onPointerWithin;
  const [state, setState] = useState<TooltipState | undefined>(undefined);

  // Measure after paint and clamp the tooltip into the viewport. Generic
  // tooltips re-measure after content updates; interactive cards stay put.
  useLayoutEffect(() => {
    if (!state) return;
    // An interactive card should feel anchored when its live data arrives,
    // rather than jumping as it remeasures under a stationary pointer.
    if (interactive && state.left !== undefined && state.top !== undefined) {
      return;
    }
    const el = tooltipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { left, top } = placeViewportTooltip({
      target: state.targetRect,
      tooltip: { width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      ...(state.anchor === undefined ? {} : { anchor: state.anchor })
    });
    if (state.left !== left || state.top !== top) {
      setState({ ...state, left, top });
    }
  }, [interactive, state]);

  const cancelScheduledHide = useCallback((): void => {
    if (dismissTimerRef.current === undefined) return;
    window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = undefined;
  }, []);

  const hide = useCallback((): void => {
    cancelScheduledHide();
    pointerInInteractiveTooltipRef.current = false;
    stickyRef.current = false;
    // The card is going, so the pointer is not in it by any reading a user
    // would give — and `leaveInteractiveTooltip` cannot say so once the node
    // is gone. Whichever channel reports pointer state has to be the one that
    // resets it, or a caller pausing on it stays paused with the pointer
    // nowhere near.
    onPointerWithinRef.current?.(false);
    setState(undefined);
  }, [cancelScheduledHide]);

  const setSticky = useCallback((sticky: boolean): void => {
    stickyRef.current = sticky;
    if (!sticky) return;
    // Pinning while a dismissal is already counting down has to call it off,
    // or the card the user just clicked open would leave 400ms later.
    cancelScheduledHide();
    // And it clears the Escape latch. That flag exists to stop a *focus
    // restore* reopening a hover card the user just dismissed; a click or
    // Enter on the trigger is neither, and it is the same trigger, so left
    // set it would make `show` refuse the card the user just asked for while
    // the caller went on believing it had one.
    dismissedTargetRef.current = null;
  }, [cancelScheduledHide]);

  const scheduleHide = useCallback((): void => {
    if (stickyRef.current) return;
    if (!interactive) {
      hide();
      return;
    }
    cancelScheduledHide();
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = undefined;
      setState(undefined);
    }, INTERACTIVE_DISMISS_DELAY_MS);
  }, [cancelScheduledHide, hide, interactive]);

  useEffect(() => {
    return () => cancelScheduledHide();
  }, [cancelScheduledHide]);

  const show = useCallback((
    target: HTMLElement,
    content: ReactNode,
    anchor?: TooltipAnchor
  ): void => {
    // Escape dismissed this exact trigger and the user has not left it yet.
    // Returning focus to the trigger re-fires its focus handler, which would
    // otherwise reopen what they just dismissed.
    if (dismissedTargetRef.current === target) return;
    cancelScheduledHide();
    pointerInInteractiveTooltipRef.current = false;
    targetRef.current = target;
    contentByTargetRef.current.set(target, content);
    setState({
      content,
      targetRect: rectOf(target.getBoundingClientRect()),
      ...(anchor === undefined ? {} : { anchor })
    });
  }, [cancelScheduledHide]);

  const hideFrom = useCallback((event: {
    relatedTarget: EventTarget | null;
  }): void => {
    // Where the pointer went. If it is still inside a trigger that has shown
    // a card before — the row this tag or path sits in — that card is what
    // should be on screen now, because its own `mouseenter` will not fire
    // again for a descendant it never lost the pointer to.
    const to = event.relatedTarget;
    if (to instanceof HTMLElement) {
      for (let el: HTMLElement | null = to; el !== null; el = el.parentElement) {
        const remembered = contentByTargetRef.current.get(el);
        if (remembered !== undefined) {
          show(el, remembered);
          return;
        }
      }
    }
    hide();
  }, [hide, show]);

  const update = useCallback((content: ReactNode): void => {
    setState((current) => (current ? { ...current, content } : current));
  }, []);

  const visible = state !== undefined;
  useEffect(() => {
    if (!visible) return;
    const onScroll = (): void => {
      // Playwright and browsers can emit a scroll while bringing a control in
      // this card into view. Once the user has reached an interactive card,
      // that mechanical scroll must not make the card run away from its own
      // controls. A scroll while outside the card still dismisses it normally.
      //
      // Focus counts as having reached it, not just the pointer: a keyboard
      // user tabs in (see the trigger handoffs in `GraphRow` and
      // `WorktreeHeader`) and never sets the pointer flag, so without this
      // any scroll anywhere — the graph adjusting scrollTop as commits stream
      // in — would take the card away with their focus still inside it.
      // A pinned card is anchored to a control that does not scroll, and the
      // user asked for it — scrolling the graph underneath is not a dismissal.
      if (stickyRef.current) return;
      if (interactive && pointerInInteractiveTooltipRef.current) return;
      if (
        interactive &&
        tooltipRef.current !== null &&
        tooltipRef.current.contains(document.activeElement)
      ) {
        return;
      }
      hide();
    };
    // WCAG 2.1 SC 1.4.13: content shown on hover must be dismissible without
    // moving the pointer or focus. Hovering elsewhere is not a substitute —
    // and a gated card takes deliberate effort to summon, so a user who did
    // not want it needs a way out that is not "move the mouse and wait".
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Defer if something already claimed it — the same rule this handler
      // relies on surfaces underneath obeying. A click-opened overlay
      // (useDismissable) can be up at the same time as a hover card, and one
      // keystroke must not dismiss both.
      if (event.defaultPrevented) return;
      // A keyboard user may have tabbed into the card. Dismissing it must not
      // drop them at the top of the document — send them back to the trigger
      // they opened it from.
      const card = tooltipRef.current;
      const leavingFocusBehind =
        card !== null && card.contains(document.activeElement);
      const trigger = targetRef.current;
      // Dismiss always; claim only a card the keyboard summoned, so an Escape
      // meant for the surface underneath still reaches it. Why, and why
      // `:focus-visible` rather than `:focus`: "A hover card claims Escape
      // only if the keyboard summoned it" in this directory's AGENTS.md.
      const summonedByKeyboard =
        leavingFocusBehind || trigger?.matches(":focus-visible") === true;
      if (summonedByKeyboard) event.preventDefault();
      hide();
      // The dismissal is released by the trigger's own exit, listened for
      // here rather than folded into hide()/scheduleHide(): restoring focus
      // below blurs a control inside the card, and the card's blur handler
      // schedules a hide — which would drop the flag a moment before the
      // trigger's focus handler reads it, reopening what was just dismissed.
      //
      // Only on the claiming path. The flag exists for that focus restore, and
      // nothing re-fires on a trigger the pointer is merely resting on — while
      // the keystroke we did NOT claim is, by now, closing the surface that
      // trigger lives in. Latching it there pins a removed element, and
      // `parentNode` keeps its whole detached subtree alive with it.
      if (summonedByKeyboard && trigger !== null) {
        dismissedTargetRef.current = trigger;
        const release = (): void => {
          dismissedTargetRef.current = null;
          trigger.removeEventListener("mouseleave", release);
          trigger.removeEventListener("blur", release);
        };
        trigger.addEventListener("mouseleave", release);
        trigger.addEventListener("blur", release);
      }
      if (leavingFocusBehind) trigger?.focus();
    };
    window.addEventListener("blur", hide);
    window.addEventListener("scroll", onScroll, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("blur", hide);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [visible, hide, interactive]);

  const enterInteractiveTooltip = useCallback((): void => {
    pointerInInteractiveTooltipRef.current = true;
    cancelScheduledHide();
    onPointerWithinRef.current?.(true);
  }, [cancelScheduledHide]);

  const leaveInteractiveTooltip = useCallback((): void => {
    pointerInInteractiveTooltipRef.current = false;
    scheduleHide();
    onPointerWithinRef.current?.(false);
  }, [scheduleHide]);

  const focusFirst = useCallback((): boolean => {
    const card = tooltipRef.current;
    const target =
      card?.querySelector<HTMLElement>("[data-focus-first]") ??
      card?.querySelector<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"
      );
    if (target === undefined || target === null) return false;
    target.focus();
    return true;
  }, []);

  const tooltipNode =
    state && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={tooltipRef}
            role={interactive ? "dialog" : "tooltip"}
            aria-label={interactive ? label : undefined}
            className={className}
            style={{
              position: "fixed",
              left: state.left,
              top: state.top,
              visibility: state.left === undefined ? "hidden" : undefined
            }}
            {...(interactive
              ? {
                  onMouseEnter: enterInteractiveTooltip,
                  onMouseLeave: leaveInteractiveTooltip,
                  onFocusCapture: cancelScheduledHide,
                  onBlurCapture: scheduleHide
                }
              : {})}
          >
            {state.content}
          </div>,
          document.body
        )
      : null;

  return {
    show,
    update,
    hide,
    hideFrom,
    scheduleHide,
    setSticky,
    focusFirst,
    visible,
    tooltipNode
  };
}
