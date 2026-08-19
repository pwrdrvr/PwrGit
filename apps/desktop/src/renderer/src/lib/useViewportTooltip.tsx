import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
  /** Delay dismissal long enough to cross from a hover target into a card. */
  scheduleHide: () => void;
  /** Move keyboard focus into the first control in an open tooltip. */
  focusFirst: () => boolean;
  visible: boolean;
  tooltipNode: ReactNode;
};

type ViewportTooltipOptions = {
  /** Interactive cards remain open while the pointer moves from their target. */
  interactive?: boolean;
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
  { interactive = false }: ViewportTooltipOptions = {}
): ViewportTooltip {
  const tooltipRef = useRef<HTMLDivElement>(null);
  /** The element this tooltip was opened from, for returning focus. */
  const targetRef = useRef<HTMLElement | null>(null);
  /** A trigger whose tooltip Escape dismissed, until the pointer or focus
   * leaves it. Without this the card reopens the instant focus returns. */
  const dismissedTargetRef = useRef<HTMLElement | null>(null);
  const dismissTimerRef = useRef<number | undefined>(undefined);
  const pointerInInteractiveTooltipRef = useRef(false);
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
    setState(undefined);
  }, [cancelScheduledHide]);

  const scheduleHide = useCallback((): void => {
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
    setState({
      content,
      targetRect: rectOf(target.getBoundingClientRect()),
      ...(anchor === undefined ? {} : { anchor })
    });
  }, [cancelScheduledHide]);

  const update = useCallback((content: ReactNode): void => {
    setState((current) => (current ? { ...current, content } : current));
  }, []);

  const visible = state !== undefined;
  useEffect(() => {
    if (!visible) return;
    const onScroll = (): void => {
      // Playwright and browsers can emit a scroll while bringing a control in
      // this card into view. Once the pointer has reached an interactive card,
      // that mechanical scroll must not make the card run away from its own
      // controls. A scroll while outside the card still dismisses it normally.
      if (interactive && pointerInInteractiveTooltipRef.current) return;
      hide();
    };
    // WCAG 2.1 SC 1.4.13: content shown on hover must be dismissible without
    // moving the pointer or focus. Hovering elsewhere is not a substitute —
    // and a gated card takes deliberate effort to summon, so a user who did
    // not want it needs a way out that is not "move the mouse and wait".
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // This listener only exists while a card is showing, so the Escape is
      // spent on the card. Say so: surfaces underneath (the diff pane) defer
      // to a claimed Escape rather than closing on the same keystroke.
      event.preventDefault();
      // A keyboard user may have tabbed into the card. Dismissing it must not
      // drop them at the top of the document — send them back to the trigger
      // they opened it from.
      const card = tooltipRef.current;
      const leavingFocusBehind =
        card !== null && card.contains(document.activeElement);
      const trigger = targetRef.current;
      hide();
      // The dismissal is released by the trigger's own exit, listened for
      // here rather than folded into hide()/scheduleHide(): restoring focus
      // below blurs a control inside the card, and the card's blur handler
      // schedules a hide — which would drop the flag a moment before the
      // trigger's focus handler reads it, reopening what was just dismissed.
      if (trigger !== null) {
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
  }, [cancelScheduledHide]);

  const leaveInteractiveTooltip = useCallback((): void => {
    pointerInInteractiveTooltipRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  const focusFirst = useCallback((): boolean => {
    const firstControl = tooltipRef.current?.querySelector<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"
    );
    if (firstControl === undefined || firstControl === null) return false;
    firstControl.focus();
    return true;
  }, []);

  const tooltipNode =
    state && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={tooltipRef}
            role={interactive ? "dialog" : "tooltip"}
            aria-label={interactive ? "Commit context" : undefined}
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
    scheduleHide,
    focusFirst,
    visible,
    tooltipNode
  };
}
