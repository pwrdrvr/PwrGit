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

type TooltipState = {
  text: string;
  targetTop: number;
  targetBottom: number;
  targetCenter: number;
  left?: number;
  top?: number;
};

export type ViewportTooltip = {
  show: (target: HTMLElement, text: string) => void;
  hide: () => void;
  tooltipNode: ReactNode;
};

/**
 * A hover/focus tooltip rendered into a portal so it escapes clipping
 * ancestors. Positions itself above the target, flips below when there isn't
 * room, and clamps to the viewport. Dismisses on window blur or any scroll.
 * Lifted from PwrAgnt's useViewportTooltip. Callers own show/hide (attach to
 * onMouseEnter/onMouseLeave/onFocus/onBlur) and render `tooltipNode`.
 */
export function useViewportTooltip(className = "viewport-tooltip"): ViewportTooltip {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TooltipState | undefined>(undefined);

  // After first paint, measure the tooltip and clamp it into the viewport.
  useLayoutEffect(() => {
    if (!state || state.left !== undefined) return;
    const el = tooltipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - rect.width - VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, state.targetCenter - rect.width / 2)
    );
    const fitsAbove =
      state.targetTop - rect.height - TOOLTIP_GAP >= VIEWPORT_PADDING;
    const top = fitsAbove
      ? state.targetTop - rect.height - TOOLTIP_GAP
      : state.targetBottom + TOOLTIP_GAP;
    setState({ ...state, left, top });
  }, [state]);

  const show = useCallback((target: HTMLElement, text: string): void => {
    const rect = target.getBoundingClientRect();
    setState({
      text,
      targetTop: rect.top,
      targetBottom: rect.bottom,
      targetCenter: rect.left + rect.width / 2
    });
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
            {state.text}
          </div>,
          document.body
        )
      : null;

  return { show, hide, tooltipNode };
}
