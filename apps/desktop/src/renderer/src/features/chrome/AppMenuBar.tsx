import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";
import type { AppMenuTopLevel } from "@pwrgit/shared";

/** Windows-only top-level application menu painted inside the custom strip. */
export function AppMenuBar(): ReactElement | null {
  const [items, setItems] = useState<AppMenuTopLevel[]>([]);
  const [focusedPosition, setFocusedPosition] = useState<number | null>(null);
  const buttonRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void window.pwrgit.getAppMenuModel().then((model) => {
        if (!cancelled) setItems(Array.isArray(model) ? model : []);
      });
    };
    load();
    // Menu structure can change with profile focus or Developer Mode.
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, []);

  useEffect(() => {
    if (focusedPosition === null) return;
    const item = items[focusedPosition];
    if (item !== undefined) buttonRefs.current.get(item.index)?.focus();
  }, [focusedPosition, items]);

  const openMenu = useCallback((index: number): void => {
    const button = buttonRefs.current.get(index);
    if (button === undefined) return;
    const rect = button.getBoundingClientRect();
    window.pwrgit.popupAppMenu({
      index,
      x: Math.round(rect.left),
      y: Math.round(rect.bottom)
    });
    setFocusedPosition(null);
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Alt") {
        if (event.repeat) return;
        event.preventDefault();
        setFocusedPosition((current) => (current === null ? 0 : null));
        return;
      }
      if (event.altKey && event.key.length === 1) {
        const key = event.key.toLowerCase();
        const match = items.find((item) =>
          item.label.toLowerCase().startsWith(key)
        );
        if (match !== undefined) {
          event.preventDefault();
          openMenu(match.index);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, openMenu]);

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (items.length === 0) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setFocusedPosition((current) =>
          ((current ?? -1) + 1) % items.length
        );
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setFocusedPosition((current) =>
          ((current ?? 0) - 1 + items.length) % items.length
        );
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const item =
          focusedPosition === null ? undefined : items[focusedPosition];
        if (item !== undefined) openMenu(item.index);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setFocusedPosition(null);
        if (event.target instanceof HTMLElement) event.target.blur();
      }
    },
    [focusedPosition, items, openMenu]
  );

  const onMenuBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>): void => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setFocusedPosition(null);
      }
    },
    []
  );

  if (items.length === 0) return null;
  return (
    <nav
      className="titlebar__menubar"
      aria-label="Application menu"
      role="menubar"
      onKeyDown={onMenuKeyDown}
      onBlur={onMenuBlur}
    >
      {items.map((item, position) => (
        <button
          key={item.index}
          type="button"
          role="menuitem"
          aria-haspopup="true"
          tabIndex={focusedPosition === position ? 0 : -1}
          ref={(element) => {
            if (element === null) buttonRefs.current.delete(item.index);
            else buttonRefs.current.set(item.index, element);
          }}
          className={
            "titlebar__menu-item" +
            (focusedPosition === position ? " is-focused" : "")
          }
          onClick={() => openMenu(item.index)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
