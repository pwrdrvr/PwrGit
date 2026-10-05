import { useEffect, useRef } from "react";
import { currentPlatform, hasPrimaryModifier } from "../../lib/platform";

type ChordEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "target"
>;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * PwrAgnt's history chords, verbatim: ⌘[ / ⌘] (Ctrl+[ / Ctrl+] off macOS)
 * anywhere, and ⌥← / ⌥→ (Alt) only outside text fields, where they move the
 * caret by word.
 */
export function matchHistoryNavChord(
  event: ChordEvent,
  platform: string = currentPlatform()
): "back" | "forward" | null {
  const primaryOnly =
    hasPrimaryModifier(event, platform) &&
    // The other primary key must be up too, or Ctrl+⌘[ would also match.
    (platform === "darwin" ? !event.ctrlKey : !event.metaKey);
  if (primaryOnly && !event.altKey && !event.shiftKey) {
    if (event.code === "BracketLeft" || event.key === "[") return "back";
    if (event.code === "BracketRight" || event.key === "]") return "forward";
    return null;
  }
  if (
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !isEditable(event.target)
  ) {
    if (event.key === "ArrowLeft") return "back";
    if (event.key === "ArrowRight") return "forward";
  }
  return null;
}

/** A dialog is up: history must not move the window out from under it. */
const modalOpen = (): boolean =>
  document.querySelector('[aria-modal="true"]') !== null;

/**
 * The one window-level listener pair for history: the chords above and a
 * mouse's thumb buttons (Chromium reports them as buttons 3 and 4). Bound
 * once, from App, so they work whatever has focus. A ref carries the latest
 * handlers so the listeners never rebind.
 */
export function useHistoryNavHotkeys(handlers: {
  onBack: () => void;
  onForward: () => void;
}): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const chord = matchHistoryNavChord(event);
      if (chord === null || modalOpen()) return;
      event.preventDefault();
      if (chord === "back") handlersRef.current.onBack();
      else handlersRef.current.onForward();
    };
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return;
      // The renderer has no webContents history, so without this the thumb
      // buttons would be dead clicks.
      event.preventDefault();
      if (modalOpen()) return;
      if (event.button === 3) handlersRef.current.onBack();
      else handlersRef.current.onForward();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
}
