import { useEffect } from "react";
import type { PrSummary } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import {
  hoverIntentHandlers,
  useHoverIntent,
  type HoverIntent
} from "../../lib/hoverIntent";
import { dispatch } from "../../lib/pwrgit";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/** A compact PR-status chip: colored dot + #number. Click opens the PR in
 *  the browser; ⌥-click copies its URL. The tooltip carries the full story —
 *  number, title, state, draft. */
export function PrChip({
  pr,
  hoverIntent: sharedIntent,
  onShowContext,
  onHideContext,
  onFocusContext
}: {
  pr: PrSummary;
  /** Callers rendering many chips (commit rows) pass their own gate; a lone
   *  sidebar chip falls back to its own. */
  hoverIntent?: HoverIntent;
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
  // The hook is cheap and must be called unconditionally; a caller-supplied
  // gate simply wins over this instance's own.
  const ownIntent = useHoverIntent();
  const hoverIntent = sharedIntent ?? ownIntent;
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
  // wake; keyboard focus still acts at once, and a click takes its tooltip
  // with it on the way to the browser.
  const chip = hoverIntentHandlers({ intent: hoverIntent, show, hide });

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
        onMouseEnter={(e) => chip.onMouseEnter(e.currentTarget)}
        onMouseLeave={chip.onMouseLeave}
        onFocus={(e) => chip.onFocus(e.currentTarget)}
        onBlur={chip.onBlur}
        onClick={(e) => {
          e.stopPropagation();
          activate(e.altKey);
          chip.leave();
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
            chip.leave();
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
