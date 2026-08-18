import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyHint, copyText } from "../../lib/copyText";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/** Comfortably past a platform double-click threshold, short enough that a
 *  deliberate single click still feels immediate. */
const DOUBLE_CLICK_GRACE_MS = 250;

/**
 * Wraps any inline content in a click-to-copy affordance: hover/focus reveals
 * the full value (handy when the visible text is truncated), clicking copies it
 * and flashes "Copied" for ~1.2s. Generalizes PwrAgnt's CopyableThreadChip.
 * `stopPropagation` (default true) keeps the click from also selecting a row.
 *
 * `deferForDoubleClick` is for content sitting inside a row that ALSO responds
 * to double-click. `dblclick` is a separate event from `click` and bubbles even
 * when the click handler stops propagation, so without this a double-click on
 * the text would copy on the way to activating the row — silently replacing the
 * user's clipboard as a side effect of an unrelated gesture. Holding the copy
 * briefly lets the second click cancel it.
 */
export function CopyTarget({
  value,
  label,
  hint,
  className,
  children,
  stopPropagation = true,
  deferForDoubleClick = false
}: {
  value: string;
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
  stopPropagation?: boolean;
  /** Wait out the double-click threshold before copying, so a double-click on
   *  this content activates its row without also touching the clipboard. */
  deferForDoubleClick?: boolean;
}) {
  const tooltip = useViewportTooltip();
  const [copied, setCopied] = useState(false);
  const tipText = copied ? "Copied" : (hint ?? copyHint(value));
  const pendingCopy = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  useEffect(
    () => () => {
      if (pendingCopy.current !== undefined) {
        window.clearTimeout(pendingCopy.current);
      }
    },
    []
  );

  const copyNow = (target: HTMLElement): void => {
    void copyText(value).then(() => {
      setCopied(true);
      tooltip.show(target, "Copied");
    });
  };

  /** `detail` is the click count, so the second click of a double-click cancels
   *  the first one's pending copy instead of adding a second. */
  const copy = (target: HTMLElement, clickCount: number): void => {
    if (!deferForDoubleClick) {
      copyNow(target);
      return;
    }
    if (pendingCopy.current !== undefined) {
      window.clearTimeout(pendingCopy.current);
      pendingCopy.current = undefined;
    }
    if (clickCount > 1) return;
    pendingCopy.current = window.setTimeout(() => {
      pendingCopy.current = undefined;
      copyNow(target);
    }, DOUBLE_CLICK_GRACE_MS);
  };

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        className={className}
        onMouseEnter={(e) => tooltip.show(e.currentTarget, tipText)}
        onMouseLeave={tooltip.hide}
        onFocus={(e) => tooltip.show(e.currentTarget, tipText)}
        onBlur={tooltip.hide}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          e.preventDefault();
          copy(e.currentTarget, e.detail);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          if (stopPropagation) e.stopPropagation();
          e.preventDefault();
          // The keyboard cannot produce a double-click, so never defer here.
          copyNow(e.currentTarget);
        }}
      >
        {children}
      </span>
      {tooltip.tooltipNode}
    </>
  );
}
