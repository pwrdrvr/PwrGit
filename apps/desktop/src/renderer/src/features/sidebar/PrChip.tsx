import { useEffect } from "react";
import type { PrSummary } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { dispatch } from "../../lib/pwrgit";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/** A compact PR-status chip: colored dot + #number. Click opens the PR in
 *  the browser; ⌥-click copies its URL. The tooltip carries the full story —
 *  number, title, state, draft. */
export function PrChip({ pr }: { pr: PrSummary }) {
  const {
    show: showTooltip,
    hide: hideTooltip,
    update: updateTooltip,
    tooltipNode
  } = useViewportTooltip();
  // GitHub's terminal lifecycle wins over a stale draft bit. This also mirrors
  // PwrAgnt: the bar is an affordance for open drafts only.
  const isDraft = pr.state === "open" && pr.isDraft;
  const label =
    pr.state === "merged"
      ? `merged #${pr.number}`
      : pr.state === "closed"
      ? `closed #${pr.number}`
        : `#${pr.number}`;
  const tooltipText = `#${pr.number} — ${pr.title || "untitled"}\n${pr.state}${
    isDraft ? " · draft" : ""
  }\nClick to open · ⌥-click to copy URL`;
  const open = (): void => void dispatch("shell:openExternal", { url: pr.url });
  const activate = (altKey: boolean): void => {
    if (altKey) void copyText(pr.url);
    else open();
  };

  // Keep an already-visible tooltip accurate when a targeted PR refresh lands.
  useEffect(() => {
    updateTooltip(tooltipText);
  }, [tooltipText, updateTooltip]);

  return (
    <>
      <span
        className={`pr-chip pr-chip--${pr.state}${isDraft ? " pr-chip--draft" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`PR #${pr.number} (${pr.state}) — Enter opens in browser`}
        onMouseEnter={(e) => showTooltip(e.currentTarget, tooltipText)}
        onMouseLeave={hideTooltip}
        onFocus={(e) => showTooltip(e.currentTarget, tooltipText)}
        onBlur={hideTooltip}
        onClick={(e) => {
          e.stopPropagation();
          activate(e.altKey);
          hideTooltip();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            activate(e.altKey);
            hideTooltip();
          }
        }}
      >
        <span className="pr-chip__dot" aria-hidden="true" />
        <span className="pr-chip__label">{label}</span>
        {isDraft && (
          <span className="pr-chip__draft-bar" aria-hidden="true" />
        )}
      </span>
      {tooltipNode}
    </>
  );
}
