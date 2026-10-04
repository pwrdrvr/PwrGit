import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { CheckGlyph } from "../../lib/CheckGlyph";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

export type PullMenuRow = {
  key: string;
  title: ReactNode;
  /** Where this choice moves commits, drawn as a one-line route. */
  route?: ReactNode;
  detail: ReactNode;
  onSelect: () => void;
};

/**
 * The arrow half of a split Pull, and the menu it opens.
 *
 * `choices` are what Pull can remember doing — `menuitemradio`, with the one
 * the button will run checked. That is not always the one kept: Sync falls
 * back to the tracked branch once the source has nothing new, and a tick on
 * the kept choice then pointed at something Pull was not going to do. The
 * kept choice says so in words instead ("Your default for this repo"), so
 * both facts show without a second checkmark (Post-ship 2d). `actions` are
 * one-off reviews offered while the
 * branch has commits the source lacks; they sit above the choices, under
 * `note`, because they are what that state is asking for.
 *
 * The same mechanics as `WorktreeMenu` beside it: portalled to <body> so no
 * scroller clips it, Escape and focus-return through `useDismissable`, the
 * arrow-key contract through `useMenuNavigation`. It opens right-aligned to
 * `anchorRef`, the whole split, so it reads as the menu of Pull rather than of
 * the 22px arrow.
 */
export function PullMenu({
  anchorRef,
  disabled,
  note,
  actions,
  choices,
  checked,
  kept
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Something is running; the arrow stays focusable but does nothing. */
  disabled: boolean;
  note?: ReactNode;
  actions: PullMenuRow[];
  choices: PullMenuRow[];
  /** The `key` of the choice Pull will run. */
  checked: string;
  /** The `key` of the choice kept for this repository. */
  kept: string;
}) {
  const tip = useViewportTooltip();
  const noteId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const open = pos !== null;

  const close = (): void => setPos(null);
  const toggle = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    if (open) {
      close();
      return;
    }
    if (disabled) return;
    // The tooltip names what the arrow is for; the menu now says it better,
    // and the two would stack.
    tip.hide();
    const r = (anchorRef.current ?? btnRef.current)?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  useDismissable({ open, onDismiss: close, triggerRef: btnRef, surfaceRef: menuRef });
  useMenuNavigation({ open, menuRef, onClose: close });

  // An operation that starts while the menu is up (a Pull pressed from the
  // keyboard, one started in another window) takes the menu with it.
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const pick = (e: ReactMouseEvent, fn: () => void): void => {
    e.stopPropagation();
    e.preventDefault();
    close();
    fn();
  };

  const row = (item: PullMenuRow, radio: boolean): ReactNode => {
    const on = radio && item.key === checked;
    return (
      <button
        key={item.key}
        type="button"
        className="pop-menu__item pull-menu__item"
        role={radio ? "menuitemradio" : "menuitem"}
        {...(radio ? { "aria-checked": on } : {})}
        onClick={(e) => pick(e, item.onSelect)}
      >
        <span className="pull-menu__check">{on && <CheckGlyph />}</span>
        <span className="pull-menu__text">
          <span className="pull-menu__title">{item.title}</span>
          {item.route !== undefined && (
            <span className="pull-menu__route">{item.route}</span>
          )}
          <span className="pull-menu__detail">
            {radio && item.key === kept && (
              <span className="pull-menu__kept">Your default for this repo. </span>
            )}
            {item.detail}
          </span>
        </span>
      </button>
    );
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="wt-btn wt-split__caret"
        aria-label="More pull options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
        {...hoverTooltip(tip, open ? undefined : "Choose what Pull does")}
        onClick={toggle}
      >
        <ChevronGlyph up={open} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="pop-menu pull-menu"
            role="menu"
            aria-label="Pull"
            // The note is why the reviews lead; a screen reader hears it as
            // the menu opens rather than never (it was aria-hidden).
            {...(note === undefined ? {} : { "aria-describedby": noteId })}
            style={{ position: "fixed", top: pos.top, right: pos.right }}
          >
            {note !== undefined && (
              <div id={noteId} className="pull-menu__note">
                {note}
              </div>
            )}
            {actions.map((item) => row(item, false))}
            {actions.length > 0 && (
              <div className="pop-menu__sep" role="separator" />
            )}
            {choices.map((item, index) => (
              <FragmentWithSep key={item.key} sep={index === choices.length - 1 && index > 0}>
                {row(item, true)}
              </FragmentWithSep>
            ))}
          </div>,
          document.body
        )}
      {tip.tooltipNode}
    </>
  );
}

/** The last choice is the tracked branch — the escape hatch — so a rule sets
 *  it apart from the two that act on the source. */
function FragmentWithSep({
  sep,
  children
}: {
  sep: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {sep && <div className="pop-menu__sep" role="separator" />}
      {children}
    </>
  );
}
