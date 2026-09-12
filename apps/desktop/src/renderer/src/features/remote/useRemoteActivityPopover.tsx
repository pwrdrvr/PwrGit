import { useCallback, useEffect, useRef, type ReactNode } from "react";
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
  /** Which operation the pending open belongs to, so a stale one is not
   *  mistaken for this one already being handled. */
  const pendingFor = useRef<string | null>(null);
  // The deferred open below fires from a timer, and the only handler that
  // cancels it is `close()` — which stops existing the moment the operation
  // ends and the trigger drops its listeners. Read the live record through a
  // ref so the timer can tell "still running" from "finished while I waited".
  const latest = useRef<RemoteActivity | null>(activity);
  latest.current = activity;
  // The trigger the pointer (or focus) is resting on, whether or not there is
  // yet a record to report. See the re-arm effect below.
  const resting = useRef<HTMLElement | null>(null);
  const releaseResting = useRef<(() => void) | null>(null);
  // One tick per second, and only while the card is on screen — the readouts
  // it exists for ("no response for 2m 41s") are counted in seconds.
  const now = useSecondsClock(visible);

  const cancelPending = useCallback((): void => {
    pendingFor.current = null;
    if (pending.current === undefined) return;
    window.clearTimeout(pending.current);
    pending.current = undefined;
  }, []);

  const forgetTrigger = useCallback((): void => {
    releaseResting.current?.();
  }, []);

  /**
   * Remember where the pointer is, and notice for ourselves when it leaves.
   *
   * `close()` cannot be trusted to tell us: it is a React prop on a control
   * that stops being a trigger the moment its operation ends, so a pointer
   * that wanders off after that is never recorded as having left. A listener
   * on the element itself outlives the prop — the same trick
   * `useViewportTooltip` uses to release an Escape-dismissed trigger — and it
   * is what keeps a remembered trigger from opening a card for some LATER
   * operation, beside a pointer that is no longer anywhere near it.
   */
  const restOn = useCallback(
    (target: HTMLElement): void => {
      if (resting.current === target) return;
      forgetTrigger();
      resting.current = target;
      const release = (): void => {
        target.removeEventListener("mouseleave", release);
        target.removeEventListener("blur", release);
        // Only this trigger's own record is ours to drop: the pointer may
        // already have been handed on to the chip beside us.
        if (resting.current !== target) return;
        resting.current = null;
        releaseResting.current = null;
      };
      releaseResting.current = release;
      target.addEventListener("mouseleave", release);
      target.addEventListener("blur", release);
    },
    [forgetTrigger]
  );

  useEffect(
    () => () => {
      cancelPending();
      forgetTrigger();
    },
    [cancelPending, forgetTrigger]
  );

  /** Open the card for the live record, once it is old enough to earn one. */
  const arm = useCallback(
    (target: HTMLElement): void => {
      const live = latest.current;
      // Nothing to report yet. The trigger is remembered, and the effect below
      // comes back here the moment a record arrives.
      if (live === null) return;
      cancelPending();
      const wait =
        REMOTE_ACTIVITY_POPOVER_AFTER_MS - (Date.now() - live.startedAt);
      if (wait <= 0) {
        show(target, <RemoteActivityCard activity={live} now={Date.now()} />);
        return;
      }
      const id = live.id;
      pendingFor.current = id;
      pending.current = window.setTimeout(() => {
        pending.current = undefined;
        pendingFor.current = null;
        const atFire = latest.current;
        if (atFire === null || atFire.id !== id) return;
        show(target, <RemoteActivityCard activity={atFire} now={Date.now()} />);
      }, wait);
    },
    [cancelPending, show]
  );

  // A hover that lands before the operation's record does must not be lost.
  //
  // Clicking Pull turns the button busy from the renderer's own state, one or
  // more renders BEFORE main reports the operation — and the glyph/spinner
  // swap fires `mouseenter` under the stationary pointer somewhere in that
  // window. Which side of the record that enter lands on is a race the user
  // cannot see and cannot influence: lose it and the pointer is already inside
  // the button, so no further enter is ever coming and the card never opens no
  // matter how long they wait. Re-arming when the record arrives makes the
  // answer to "what is it doing?" depend on where the pointer is, not on when
  // an event happened to fire.
  //
  // Keyed on the operation, not on every half-second update of it: re-arming
  // per update would restart the age gate's timer over and over. A wait
  // already counting down for THIS operation is left alone for the same
  // reason; one left over from a finished operation is not, or an operation
  // that replaced it inside the gate would never be armed at all.
  const operationId = activity?.id ?? null;
  useEffect(() => {
    if (operationId === null || visible) return;
    if (pending.current !== undefined && pendingFor.current === operationId) {
      return;
    }
    const target = resting.current;
    // A trigger torn out from under a stationary pointer never gets to say the
    // pointer left it, so drop it here rather than hold a detached node and
    // its listeners for the life of the hook.
    if (target === null) return;
    if (!target.isConnected) {
      forgetTrigger();
      return;
    }
    arm(target);
  }, [arm, forgetTrigger, operationId, visible]);

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
      restOn(target);
      arm(target);
    },
    close: () => {
      forgetTrigger();
      cancelPending();
      scheduleHide();
    },
    node: tooltip.tooltipNode
  };
}
