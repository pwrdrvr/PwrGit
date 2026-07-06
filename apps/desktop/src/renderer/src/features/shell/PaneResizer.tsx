import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * A draggable column divider positioned over a pane edge. `offset` is the px
 * distance from the pane's side to the edge being dragged; `side` picks which
 * edge (left → measured from the left, for the sidebar; right → from the right,
 * for the rail). Pointer-drag is owned by useColumnResize; arrow keys nudge.
 */
export function PaneResizer({
  side,
  offset,
  width,
  min,
  max,
  onPointerDown,
  onNudge,
  onReset,
  ariaLabel
}: {
  side: "left" | "right";
  offset: number;
  width: number;
  min: number;
  max: number;
  onPointerDown: (e: ReactPointerEvent) => void;
  onNudge: (delta: number) => void;
  onReset: () => void;
  ariaLabel: string;
}) {
  const style = side === "left" ? { left: `${offset}px` } : { right: `${offset}px` };
  // The pane should grow toward the arrow pressed: for a left-edge handle
  // ArrowRight widens; for a right-edge handle ArrowRight narrows.
  const growKey = side === "left" ? 16 : -16;

  return (
    <div
      className={`pane-resizer pane-resizer--${side}`}
      style={style}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          onNudge(growKey);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNudge(-growKey);
        }
      }}
    />
  );
}
