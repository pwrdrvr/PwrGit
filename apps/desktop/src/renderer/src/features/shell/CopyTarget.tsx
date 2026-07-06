import { useEffect, useState, type ReactNode } from "react";
import { copyHint, copyText } from "../../lib/copyText";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * Wraps any inline content in a click-to-copy affordance: hover/focus reveals
 * the full value (handy when the visible text is truncated), clicking copies it
 * and flashes "Copied" for ~1.2s. Generalizes PwrAgnt's CopyableThreadChip.
 * `stopPropagation` (default true) keeps the click from also selecting a row.
 */
export function CopyTarget({
  value,
  label,
  hint,
  className,
  children,
  stopPropagation = true
}: {
  value: string;
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
  stopPropagation?: boolean;
}) {
  const tooltip = useViewportTooltip();
  const [copied, setCopied] = useState(false);
  const tipText = copied ? "Copied" : (hint ?? copyHint(value));

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = (target: HTMLElement): void => {
    void copyText(value).then(() => {
      setCopied(true);
      tooltip.show(target, "Copied");
    });
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
          copy(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          if (stopPropagation) e.stopPropagation();
          e.preventDefault();
          copy(e.currentTarget);
        }}
      >
        {children}
      </span>
      {tooltip.tooltipNode}
    </>
  );
}
