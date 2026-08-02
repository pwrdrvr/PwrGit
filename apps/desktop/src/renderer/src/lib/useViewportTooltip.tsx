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
  target: HTMLElement;
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
  /** Re-anchor an open tooltip at the current pointer position. */
  move: (target: HTMLElement, anchor: TooltipAnchor) => void;
  /** Replace an open tooltip's content without making it blink. */
  update: (content: ReactNode) => void;
  hide: () => void;
  visible: boolean;
  tooltipNode: ReactNode;
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
 * callers retain target-centred placement. Dismisses on window blur or any
 * scroll. Callers own show/hide and render `tooltipNode`. Content can be a
 * structured card, not just a text string.
 */
export function useViewportTooltip(className = "viewport-tooltip"): ViewportTooltip {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TooltipState | undefined>(undefined);

  // Measure after paint and clamp the tooltip into the viewport. Content
  // updates re-measure too, allowing a live card to grow or shrink in place.
  useLayoutEffect(() => {
    if (!state) return;
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
  }, [state]);

  const show = useCallback((
    target: HTMLElement,
    content: ReactNode,
    anchor?: TooltipAnchor
  ): void => {
    setState({
      content,
      target,
      targetRect: rectOf(target.getBoundingClientRect()),
      ...(anchor === undefined ? {} : { anchor })
    });
  }, []);

  const move = useCallback((target: HTMLElement, anchor: TooltipAnchor): void => {
    setState((current) => {
      if (
        current === undefined ||
        current.target !== target ||
        (current.anchor?.x === anchor.x && current.anchor.y === anchor.y)
      ) {
        return current;
      }
      return { ...current, anchor };
    });
  }, []);

  const update = useCallback((content: ReactNode): void => {
    setState((current) => (current ? { ...current, content } : current));
  }, []);

  const hide = useCallback((): void => setState(undefined), []);

  const visible = state !== undefined;
  useEffect(() => {
    if (!visible) return;
    window.addEventListener("blur", hide);
    window.addEventListener("scroll", hide, { capture: true });
    return () => {
      window.removeEventListener("blur", hide);
      window.removeEventListener("scroll", hide, { capture: true });
    };
  }, [visible, hide]);

  const tooltipNode =
    state && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className={className}
            style={{
              position: "fixed",
              left: state.left,
              top: state.top,
              visibility: state.left === undefined ? "hidden" : undefined
            }}
          >
            {state.content}
          </div>,
          document.body
        )
      : null;

  return { show, move, update, hide, visible, tooltipNode };
}
