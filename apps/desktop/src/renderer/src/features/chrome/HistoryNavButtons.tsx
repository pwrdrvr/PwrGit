import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";
import { currentPlatform, shortcutLabel } from "../../lib/platform";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";

export type HistoryNavControls = {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Where Back leads, named in its tooltip so the hop is not a guess. */
  backLabel?: string;
  forwardLabel?: string;
  onBack: () => void;
  onForward: () => void;
  /** The history list, built when the menu opens. */
  menuItems: () => MenuItem[];
};

/** Safari's and Chrome's press-and-hold delay, near enough. */
const HOLD_MS = 450;

function Chevron({ back }: { back: boolean }): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={back ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

/**
 * Back/Forward for the window's worktree selection, PwrAgnt's
 * `HistoryNavButtons` on PwrGit's title strip. The buttons only fire the
 * callbacks: history lives in `useNavigationHistory`, and the window-wide
 * chords and thumb buttons are bound once in App (`useHistoryNavHotkeys`).
 *
 * One addition PwrAgnt doesn't have: right-click either chip, press and hold
 * it, or press the context-menu key on it for the list of places, so "back
 * three" is one pick rather than three presses.
 */
export function HistoryNavButtons(
  props: HistoryNavControls & { platform?: string }
): ReactElement {
  const platform = props.platform ?? currentPlatform();
  const tip = useViewportTooltip();
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    trigger: "back" | "forward";
  } | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const forwardRef = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  // The click that ends a press-and-hold must not also step.
  const held = useRef(false);
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);

  const backKey = shortcutLabel({ key: "[" }, platform);
  const forwardKey = shortcutLabel({ key: "]" }, platform);
  const backTip =
    props.canGoBack && props.backLabel !== undefined
      ? `Back to ${props.backLabel}  (${backKey})`
      : `Back  (${backKey})`;
  const forwardTip =
    props.canGoForward && props.forwardLabel !== undefined
      ? `Forward to ${props.forwardLabel}  (${forwardKey})`
      : `Forward  (${forwardKey})`;
  const anyHistory = props.canGoBack || props.canGoForward;

  const openMenu = (trigger: "back" | "forward"): void => {
    const el = (trigger === "back" ? backRef : forwardRef).current;
    if (el === null || !anyHistory) return;
    tip.hide();
    const rect = el.getBoundingClientRect();
    setMenu({
      x: rect.left,
      y: rect.bottom + 4,
      items: props.menuItems(),
      trigger
    });
  };
  const holdHandlers = (trigger: "back" | "forward") => ({
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      held.current = false;
      window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => {
        held.current = true;
        openMenu(trigger);
      }, HOLD_MS);
    },
    onPointerUp: () => window.clearTimeout(holdTimer.current),
    onPointerLeave: () => window.clearTimeout(holdTimer.current),
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      openMenu(trigger);
    },
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        openMenu(trigger);
      }
    }
  });
  const step = (go: () => void) => () => {
    if (held.current) {
      held.current = false;
      return;
    }
    go();
  };

  return (
    <div className="history-nav" role="group" aria-label="History">
      <button
        ref={backRef}
        type="button"
        className="history-nav__chip"
        aria-label="Back"
        {...(props.canGoBack && props.backLabel !== undefined
          ? { "aria-description": props.backLabel }
          : {})}
        data-testid="history-nav-back"
        disabled={!props.canGoBack}
        onClick={step(props.onBack)}
        {...holdHandlers("back")}
        {...hoverTooltip(tip, backTip)}
      >
        <Chevron back />
      </button>
      <button
        ref={forwardRef}
        type="button"
        className="history-nav__chip"
        aria-label="Forward"
        {...(props.canGoForward && props.forwardLabel !== undefined
          ? { "aria-description": props.forwardLabel }
          : {})}
        data-testid="history-nav-forward"
        disabled={!props.canGoForward}
        onClick={step(props.onForward)}
        {...holdHandlers("forward")}
        {...hoverTooltip(tip, forwardTip)}
      >
        <Chevron back={false} />
      </button>
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="History"
          items={menu.items}
          triggerRef={menu.trigger === "back" ? backRef : forwardRef}
          onClose={() => {
            // A hold released off the chip sends no click to swallow, so the
            // flag must not outlive the menu it opened.
            held.current = false;
            setMenu(null);
          }}
        />
      )}
      {tip.tooltipNode}
    </div>
  );
}
