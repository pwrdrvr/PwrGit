import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";
import type { Worktree } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";

const revealLabel =
  typeof navigator === "undefined"
    ? "Show in folder"
    : navigator.platform.startsWith("Mac")
      ? "Reveal in Finder"
      : navigator.platform.startsWith("Win")
        ? "Show in Explorer"
        : "Show in folder";

/**
 * A "⋯" actions menu for a worktree: copy branch/path, reveal in the OS file
 * manager, and (for non-primary worktrees) remove. The dropdown is portalled to
 * <body> so the sidebar's scroll container can't clip it.
 */
export function WorktreeMenu({
  worktree,
  onRemove,
  className
}: {
  worktree: Worktree;
  onRemove?: () => void;
  className?: string;
}) {
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
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const pick = (e: ReactMouseEvent, fn: () => void): void => {
    e.stopPropagation();
    e.preventDefault();
    fn();
    close();
  };

  return (
    <div className={`kebab${className ? ` ${className}` : ""}`}>
      <button
        ref={btnRef}
        className="kebab__btn"
        aria-label="Worktree actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={toggle}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.55" />
          <circle cx="12" cy="12" r="1.55" />
          <circle cx="12" cy="19" r="1.55" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="kebab__menu"
            role="menu"
            style={{ position: "fixed", top: pos.top, right: pos.right }}
          >
            <button
              className="kebab__item"
              role="menuitem"
              onClick={(e) => pick(e, () => void copyText(worktree.branch))}
            >
              Copy branch name
            </button>
            <button
              className="kebab__item"
              role="menuitem"
              onClick={(e) => pick(e, () => void copyText(worktree.path))}
            >
              Copy path
            </button>
            <button
              className="kebab__item"
              role="menuitem"
              onClick={(e) =>
                pick(e, () =>
                  void dispatch("shell:revealPath", { path: worktree.path })
                )
              }
            >
              {revealLabel}
            </button>
            {onRemove !== undefined && !worktree.isPrimary && (
              <>
                <div className="kebab__sep" />
                <button
                  className="kebab__item kebab__item--danger"
                  role="menuitem"
                  onClick={(e) => pick(e, onRemove)}
                >
                  Remove worktree
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
