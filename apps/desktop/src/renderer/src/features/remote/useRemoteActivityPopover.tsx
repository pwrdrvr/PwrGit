import { useEffect, useRef, type ReactNode } from "react";
import type { RemoteActivity } from "@pwrgit/shared";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { useSecondsClock } from "../../state/useRemoteActivity";
import { RemoteActivityCard } from "./RemoteActivityCard";

/**
 * How old an operation must be before its card will open.
 *
 * Not a hover dwell — the wait is measured from when the *operation* started,
 * so it is already satisfied for anything that has been running a while and
 * such a hover opens instantly.
 *
 * It exists because clicking Pull leaves the pointer resting on the button,
 * and re-rendering that button with its spinner fires `mouseenter` under the
 * stationary pointer. Without this, every ordinary one-second pull threw a
 * card over the graph and took it away again. The user asked for a status that
 * is reachable, not one that is front and centre.
 */
export const REMOTE_ACTIVITY_POPOVER_AFTER_MS = 1_200;

export type RemoteActivityPopover = {
  /** Wire to the busy control's mouseenter/focus, passing `currentTarget`. */
  open: (target: HTMLElement) => void;
  /** Wire to mouseleave/blur; the pointer keeps a grace period to cross in. */
  close: () => void;
  node: ReactNode;
};

/**
 * The status card, hung off whichever toolbar control is currently working.
 *
 * Hover-opened without a dwell gate on purpose: `lib/AGENTS.md` reserves
 * `useHoverIntent` for triggers that repeat down a column the pointer crosses
 * on its way elsewhere. These are one button and the chip beside it, both of
 * which the user had to aim at, and they are only triggers at all while an
 * operation is running — so there is no sweep to suppress.
 *
 * Interactive, because the card carries the Cancel button: the pointer has to
 * be able to travel from the trigger into it.
 */
export function useRemoteActivityPopover(
  activity: RemoteActivity | null
): RemoteActivityPopover {
  const tooltip = useViewportTooltip("remote-activity-popover", {
    interactive: true,
    label: "Git operation status"
  });
  const { show, update, hide, scheduleHide, visible } = tooltip;
  const pending = useRef<number | undefined>(undefined);
  // One tick per second, and only while the card is on screen — the readouts
  // it exists for ("no response for 2m 41s") are counted in seconds.
  const now = useSecondsClock(visible);

  const cancelPending = (): void => {
    if (pending.current === undefined) return;
    window.clearTimeout(pending.current);
    pending.current = undefined;
  };

  useEffect(() => cancelPending, []);

  useEffect(() => {
    if (!visible) return;
    // The operation finished while its card was open. Nothing left to report.
    if (activity === null) {
      hide();
      return;
    }
    update(<RemoteActivityCard activity={activity} now={now} />);
  }, [activity, hide, now, update, visible]);

  return {
    open: (target) => {
      if (activity === null) return;
      cancelPending();
      const card = (): ReactNode => (
        <RemoteActivityCard activity={activity} now={Date.now()} />
      );
      const wait =
        REMOTE_ACTIVITY_POPOVER_AFTER_MS - (Date.now() - activity.startedAt);
      if (wait <= 0) {
        show(target, card());
        return;
      }
      pending.current = window.setTimeout(() => {
        pending.current = undefined;
        show(target, card());
      }, wait);
    },
    close: () => {
      cancelPending();
      scheduleHide();
    },
    node: tooltip.tooltipNode
  };
}
