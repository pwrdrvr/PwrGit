import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type Side = "left" | "right";

export type ColumnResize = {
  /** Current column width in px (clamped to [min, max]). */
  width: number;
  min: number;
  max: number;
  /** Attach to the resizer handle's onPointerDown. */
  onPointerDown: (e: ReactPointerEvent) => void;
  /** Adjust width by `delta` px (positive = wider). For keyboard nudging. */
  nudge: (delta: number) => void;
  /** Snap back to the default width (double-click the handle). */
  reset: () => void;
};

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

function readStored(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Drift-free draggable column width, persisted to localStorage. `side` says
 * which edge the handle lives on: a "left" pane (sidebar) grows as the pointer
 * moves right; a "right" pane (rail) grows as it moves left. Width is captured
 * at pointer-down and derived from the absolute delta, so it never accumulates
 * rounding error the way movementX summing does.
 */
export function useColumnResize(
  key: string,
  initial: number,
  min: number,
  max: number,
  side: Side
): ColumnResize {
  const [width, setWidth] = useState(() => readStored(key, initial, min, max));
  const drag = useRef({ startX: 0, startWidth: initial });

  const onPointerDown = useCallback(
    (e: ReactPointerEvent): void => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startWidth: width };
      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - drag.current.startX;
        const raw = drag.current.startWidth + (side === "left" ? dx : -dx);
        setWidth(clamp(raw, min, max));
      };
      const onUp = (): void => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.classList.remove("is-col-resizing");
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.body.classList.add("is-col-resizing");
    },
    [width, min, max, side]
  );

  // Persist a beat after the last change so a drag doesn't hammer storage.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(key, String(Math.round(width)));
      } catch {
        // ignore quota / private-mode failures — width just won't persist
      }
    }, 200);
    return () => clearTimeout(t);
  }, [key, width]);

  const nudge = useCallback(
    (delta: number) => setWidth((w) => clamp(w + delta, min, max)),
    [min, max]
  );
  const reset = useCallback(() => setWidth(initial), [initial]);

  return { width, min, max, onPointerDown, nudge, reset };
}
