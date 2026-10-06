import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { CheckGlyph } from "../../lib/CheckGlyph";

export type MenuItem =
  | {
      type: "item";
      label: string;
      danger?: boolean;
      disabled?: boolean;
      /** A second, muted line. A disabled entry carries the reason it is
       *  disabled here: a disabled button takes no hover, so a tooltip would
       *  never show, and the reason is what a reader can act on. */
      hint?: string;
      /** Set for a toggle: the entry becomes a `menuitemcheckbox` and leads
       *  with a check slot, drawn empty when off so labels stay aligned. A
       *  check typed into the label instead was read aloud as "check mark"
       *  and announced no state. */
      checked?: boolean;
      onSelect: () => void;
    }
  | { type: "sep" };

/**
 * A context menu anchored at a screen point (right-click). Portalled to <body>,
 * clamped into the viewport, and dismissed on outside click / Escape / scroll /
 * another right-click. Shares the .pop-menu styling with the kebab dropdown.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  label,
  triggerRef,
  align = "start",
  placement = "below"
}: {
  x: number;
  y: number;
  /** Which edge of the menu `x` names. `start` for a pointer, whose menu opens
   *  rightward from where it was clicked. `end` for a trigger at the right of
   *  its row, so the menu opens back over that row rather than out across the
   *  pane beside it. That is how `WorktreeMenu`'s kebab already behaves. */
  align?: "start" | "end";
  /** `above` opens upward from `y`, for a trigger at the bottom of a pane
   *  (the sidebar's Hidden list), so the menu does not cover it. */
  placement?: "below" | "above";
  items: MenuItem[];
  onClose: () => void;
  /** Accessible menu name for callers with more specific actions. */
  label?: string;
  /** A trigger click toggles the menu instead of counting as an outside click. */
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A right-click menu has no trigger element to return focus to; the empty
  // ref makes that the no-op case rather than a special one.
  const noTrigger = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: x,
    top: y
  });

  // Mounted only while open, so `open` is constant here. Escape + focus
  // restore, and the arrow/typeahead contract its role="menu" already promised
  // — this one component is the keyboard behaviour for seven call sites.
  useDismissable({
    open: true,
    onDismiss: onClose,
    triggerRef: triggerRef ?? noTrigger,
    surfaceRef: ref
  });
  useMenuNavigation({ open: true, menuRef: ref, onClose });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = align === "end" ? x - r.width : x;
    let top = placement === "above" ? y - r.height : y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
    // Initial focus belongs to useMenuNavigation, which also seeds the roving
    // tabindex; focusing here too would fight it on every reposition.
  }, [x, y, items.length, align, placement]);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !triggerRef?.current?.contains(target)
      ) {
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, triggerRef]);

  return createPortal(
    <div
      ref={ref}
      className="pop-menu"
      role="menu"
      aria-label={label}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((it, i) =>
        it.type === "sep" ? (
          <div key={i} className="pop-menu__sep" />
        ) : (
          <button
            key={i}
            className={`pop-menu__item${it.danger === true ? " pop-menu__item--danger" : ""}`}
            role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={it.checked}
            disabled={it.disabled === true}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              it.onSelect();
              onClose();
            }}
          >
            {it.checked !== undefined && (
              <span className="pop-menu__check" aria-hidden="true">
                {it.checked && <CheckGlyph />}
              </span>
            )}
            {it.hint === undefined ? (
              it.label
            ) : (
              <span className="pop-menu__stack">
                <span>{it.label}</span>
                <span className="pop-menu__hint">{it.hint}</span>
              </span>
            )}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
