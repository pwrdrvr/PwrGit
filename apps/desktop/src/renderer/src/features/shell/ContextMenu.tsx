import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | {
      type: "item";
      label: string;
      danger?: boolean;
      disabled?: boolean;
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
  label
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Accessible menu name for callers with more specific actions. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: x,
    top: y
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

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
            role="menuitem"
            disabled={it.disabled === true}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              it.onSelect();
              onClose();
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
