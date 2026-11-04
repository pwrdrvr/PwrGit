import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Worktree } from "@pwrgit/shared";
import { ContextMenu } from "./ContextMenu";
import { worktreeMenuItems } from "./worktree-menu-items";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

/**
 * A "⋯" actions menu for a worktree. Its entries come from
 * `worktreeMenuItems`, the same list the sidebar row's right-click draws, and
 * it opens through the shared `ContextMenu` (portalled to <body>, so the
 * sidebar's scroll container can't clip it).
 */
export function WorktreeMenu({
  worktree,
  className,
  fork,
  onResetToRemote,
  onRemove,
  platform
}: {
  worktree: Worktree;
  className?: string;
  fork?: { label: string; onSelect: () => void };
  onResetToRemote?: () => void;
  onRemove?: () => void;
  /** Explicit only in deterministic platform component tests. */
  platform?: string;
}) {
  const tip = useViewportTooltip();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const toggle = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    tip.hide();
    if (pos !== null) {
      setPos(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ x: r.right, y: r.bottom + 4 });
  };

  return (
    <div className={`kebab${className ? ` ${className}` : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className="kebab__btn"
        aria-label="Worktree actions"
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        {...hoverTooltip(tip, "More actions")}
        onClick={toggle}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2.3" />
          <circle cx="12" cy="12" r="2.3" />
          <circle cx="12" cy="19" r="2.3" />
        </svg>
      </button>
      {pos !== null && (
        <ContextMenu
          x={pos.x}
          y={pos.y}
          align="end"
          label="Worktree actions"
          triggerRef={btnRef}
          items={worktreeMenuItems({
            worktree,
            ...(platform === undefined ? {} : { platform }),
            ...(fork === undefined ? {} : { fork }),
            ...(onResetToRemote === undefined ? {} : { onResetToRemote }),
            ...(onRemove === undefined ? {} : { onRemove })
          })}
          onClose={() => setPos(null)}
        />
      )}
      {tip.tooltipNode}
    </div>
  );
}
