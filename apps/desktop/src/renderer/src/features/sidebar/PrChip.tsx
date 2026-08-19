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
import { PrStatusCard } from "./PrStatusCard";

/** A compact PR-status chip: colored dot + #number. Click opens the PR in
 *  the browser; ⌥-click copies its URL. Hovering opens `PrStatusCard`, which
 *  carries the full story — title, branches, diff size, and timeline.
 *
 *  The card renders entirely from the `PrSummary` already in the tree. It
 *  issues no request of its own: hovering a chip must never reach a forge API,
 *  or a sweep across a commit list would fan out one call per chip. Fresh data
 *  arrives through main's `pr:changed` deltas like everything else. */
export function PrChip({
  pr,
  hoverIntent: sharedIntent
}: {
  pr: PrSummary;
  /** Callers rendering many chips (commit rows) pass their own gate; a lone
   *  sidebar chip falls back to its own. */
  hoverIntent?: HoverIntent;
}) {
  const {
    show: showTooltip,
    hide: hideTooltip,
    update: updateTooltip,
    tooltipNode
  } = useViewportTooltip("pr-status-card", {
    interactive: true,
    // The card is a dialog to assistive tech, so it must announce what it
    // actually shows — each forge's own word for the thing, as the card does.
    label: pr.forge === "gitlab" ? "Merge request" : "Pull request"
  });
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
  const card = <PrStatusCard pr={pr} />;
  const open = (): void => void dispatch("shell:openExternal", { url: pr.url });
  const activate = (altKey: boolean): void => {
    if (altKey) void copyText(pr.url);
    else open();
  };
  const show = (target: HTMLElement): void => showTooltip(target, card);
  const hide = (): void => hideTooltip();
  // Sweeping the pointer past a row of chips must not leave popups in its
  // wake; keyboard focus still acts at once, and a click takes its tooltip
  // with it on the way to the browser.
  const chip = hoverIntentHandlers({ intent: hoverIntent, show, hide });

  // Keep an already-visible card accurate when a targeted PR refresh lands.
  // Depends on `pr`, not the element: a new element every render would make an
  // open card re-render on every parent paint.
  useEffect(() => {
    updateTooltip(<PrStatusCard pr={pr} />);
  }, [pr, updateTooltip]);

  return (
    <>
      <span
        className={`pr-chip pr-chip--${pr.state}${isDraft ? " pr-chip--draft" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`${
          pr.forge === "gitlab" ? "Merge request" : "Pull request"
        } #${pr.number} (${pr.state}) — Enter opens in browser`}
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
      {tooltipNode}
    </>
  );
}
