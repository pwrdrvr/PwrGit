import { useEffect, useRef } from "react";
import { ASSUMED_FORGE_KIND, changeRequestLabel, type PrSummary } from "@pwrgit/shared";
import { copyText } from "../../lib/copyText";
import {
  hoverIntentHandlers,
  useHoverIntent,
  type HoverIntent
} from "../../lib/hoverIntent";
import { dispatch } from "../../lib/pwrgit";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { StackPositionChip } from "../stacks/StackPopover";
import { useStackPositionForPr } from "../stacks/stack-navigation";
import { prChipLabel, prPresentation } from "./pr-status";
import { PrStatusCard } from "./PrStatusCard";

/** A compact PR-status chip: colored dot + #number. Click opens the PR in
 *  the browser; ⌥-click copies its URL. Hovering opens `PrStatusCard`, which
 *  carries the full story — title, branches, diff size, and timeline.
 *
 *  The card renders entirely from the `PrSummary` already in the tree. It
 *  issues no request of its own: hovering a chip must never reach a forge API,
 *  or a sweep across a commit list would fan out one call per chip. Fresh data
 *  arrives through main's `pr:changed` deltas like everything else.
 *
 *  A PR in a stack, open or closed, says so wherever its chip is drawn: a
 *  `2/3` tag follows the chip, and the card lists the stack. Membership is the
 *  PR's, found by number, so a merged PR whose branch is gone keeps it. */
export function PrChip({
  pr,
  repoId,
  stacked = false,
  stackTag = true,
  stackRepoId,
  forgeRepo,
  stackWritable,
  hoverIntent: sharedIntent
}: {
  pr: PrSummary;
  /** The checkout this chip belongs to. Only with it can the card offer
   *  "Add to merge queue": main resolves the forge from its `origin`. */
  repoId?: string | undefined;
  /** Beside a stack rail: the rail node is the status and the rail is the
   *  stack, so the chip draws neither its dot nor a stack tag. */
  stacked?: boolean;
  /** False where the caller already draws this PR's stack position. */
  stackTag?: boolean;
  /** The repository whose stacks to search when it isn't `repoId`'s checkout
   *  (a Lineage row). Without either, any loaded snapshot that holds this PR
   *  by forge repository answers. */
  stackRepoId?: string | undefined;
  forgeRepo?: string | undefined;
  /** Whether the stack popover may offer Sync or Restack. */
  stackWritable?: boolean | undefined;
  /** Callers rendering many chips (commit rows) pass their own gate; a lone
   *  sidebar chip falls back to its own. */
  hoverIntent?: HoverIntent;
}) {
  const {
    show: showTooltip,
    hide: hideTooltip,
    hideFrom,
    blurFrom,
    update: updateTooltip,
    visible,
    tooltipNode
  } = useViewportTooltip("pr-status-card", {
    interactive: true,
    // The card is a dialog to assistive tech, so it must announce what it
    // actually shows — each forge's own word for the thing, as the card does.
    label: changeRequestLabel(pr.forge ?? ASSUMED_FORGE_KIND)
  });
  // The hook is cheap and must be called unconditionally; a caller-supplied
  // gate simply wins over this instance's own.
  const ownIntent = useHoverIntent();
  const hoverIntent = sharedIntent ?? ownIntent;
  // GitHub's terminal lifecycle wins over a stale draft bit. This also mirrors
  // PwrAgnt: the bar is an affordance for open drafts only.
  const status = prPresentation(pr);
  const isDraft = status.draft;
  const label = prChipLabel(pr);
  const stackPosition = useStackPositionForPr(stackRepoId ?? repoId, pr, forgeRepo);
  const card = <PrStatusCard pr={pr} repoId={repoId} stackPosition={stackPosition} />;
  const open = (): void => void dispatch("shell:openExternal", { url: pr.url });
  const activate = (altKey: boolean): void => {
    if (altKey) void copyText(pr.url);
    else open();
  };
  const show = (target: HTMLElement): void => {
    showTooltip(target, card);
  };
  const hide = (): void => hideTooltip();
  // Sweeping the pointer past a row of chips must not leave popups in its
  // wake; keyboard focus still acts at once, and a click takes its tooltip
  // with it on the way to the browser. Leaving waits, so the pointer can
  // reach the card; the next chip's card closes this one if it is still
  // waiting. See "Interactive cards must be reachable" in lib/AGENTS.md.
  const chip = hoverIntentHandlers({
    intent: hoverIntent,
    show,
    hide,
    card: { hideFrom, blurFrom }
  });

  // The card outlives the hover that opened it, so the gate's "still
  // browsing" window has to run from when it goes, not from the leave. The
  // cleanup also runs when the chip unmounts with its card open, and passing
  // the chip lets the gate drop it from `claimCard`.
  const chipRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!visible) return;
    const trigger = chipRef.current ?? undefined;
    return () => hoverIntent.cardClosed(trigger);
  }, [visible, hoverIntent]);

  // Keep an already-visible card accurate when a targeted PR refresh lands.
  // Depends on `pr`, not the element: a new element every render would make an
  // open card re-render on every parent paint.
  useEffect(() => {
    updateTooltip(<PrStatusCard pr={pr} repoId={repoId} stackPosition={stackPosition} />);
  }, [pr, repoId, stackPosition, updateTooltip]);

  return (
    <>
      <span
        className={`pr-chip pr-chip--${status.dot}${isDraft ? " pr-chip--draft" : ""}${status.running ? " pr-chip--checks-running" : ""}`}
        data-stack-state={stacked ? status.stackState : undefined}
        role="button"
        tabIndex={0}
        aria-label={`${changeRequestLabel(
          pr.forge ?? ASSUMED_FORGE_KIND
        )} #${pr.number} (${status.label}) — Enter opens in browser`}
        ref={chipRef}
        // Back onto the chip while its card waits out its grace: that card is
        // this chip's (each chip owns its own), so keep it rather than let the
        // timer take it from under the pointer while the gate re-decides.
        onMouseEnter={(e) =>
          visible
            ? chip.showNow(e.currentTarget)
            : chip.onMouseEnter(e.currentTarget)
        }
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
        {/* Beside a stack rail the rail node is this PR's status mark; a second
            dot here would say the same thing a few pixels away. */}
        {!stacked && <span className="pr-chip__dot" aria-hidden="true" />}
        <span className="pr-chip__label">{label}</span>
        {isDraft && (
          <span className="pr-chip__draft-bar" aria-hidden="true" />
        )}
      </span>
      {stackPosition && stackTag && !stacked &&
        <StackPositionChip position={stackPosition} repoId={stackRepoId ?? repoId} writable={stackWritable} />}
      {tooltipNode}
    </>
  );
}
