import { useEffect } from "react";
import type { PrSummary } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import { useHoverIntent } from "../../lib/hoverIntent";
import { dispatch } from "../../lib/pwrgit";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/** A compact PR-status chip: colored dot + #number. Click opens the PR in
 *  the browser; ⌥-click copies its URL. The tooltip carries the full story —
 *  number, title, state, draft. */
export function PrChip({
  pr,
  onShowContext,
  onHideContext,
  onFocusContext
}: {
  pr: PrSummary;
  /** Commit rows can replace the small text tooltip with their shared card. */
  onShowContext?: (target: HTMLElement) => void;
  onHideContext?: () => void;
  onFocusContext?: () => boolean;
}) {
  const {
    show: showTooltip,
    hide: hideTooltip,
    update: updateTooltip,
    tooltipNode
  } = useViewportTooltip();
  const hoverIntent = useHoverIntent();
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
  const show = (target: HTMLElement): void => {
    if (onShowContext !== undefined) onShowContext(target);
    else showTooltip(target, tooltipText);
  };
  const hide = (): void => {
    if (onHideContext !== undefined) onHideContext();
    else hideTooltip();
  };
  // Sweeping the pointer past a row of chips must not leave popups in its
  // wake; keyboard focus and clicks still act at once.
  const hoverShow = (target: HTMLElement): void =>
    hoverIntent.arm(() => show(target));
  const showNow = (target: HTMLElement): void =>
    hoverIntent.immediate(() => show(target));
  const leave = (): void => {
    hoverIntent.cancel();
    hide();
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
        onMouseEnter={(e) => hoverShow(e.currentTarget)}
        onMouseLeave={leave}
        onFocus={(e) => showNow(e.currentTarget)}
        onBlur={leave}
        onClick={(e) => {
          e.stopPropagation();
          activate(e.altKey);
          leave();
        }}
        onKeyDown={(e) => {
          if (
            e.key === "Tab" &&
            !e.shiftKey &&
            onFocusContext?.() === true
          ) {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            activate(e.altKey);
            leave();
          }
        }}
      >
        <span className="pr-chip__dot" aria-hidden="true" />
        <span className="pr-chip__label">{label}</span>
        {isDraft && (
          <span className="pr-chip__draft-bar" aria-hidden="true" />
        )}
      </span>
      {onShowContext === undefined ? tooltipNode : null}
    </>
  );
}
