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

/**
 * A trigger the pointer is on, and the wait it has earned.
 *
 * `wait` carries the operation it was armed for: a countdown left over from an
 * operation that has since finished must not read as "this one is already
 * being handled", or an operation that replaced another inside the age gate
 * would be armed by nothing at all.
 */
type Resting = {
  target: HTMLElement;
  release: () => void;
  wait: { operationId: string; timer: number } | undefined;
};

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
  // The deferred open fires from a timer, long after the render that armed it.
  // Read the live record through a ref so the timer can tell "still running"
  // from "finished while I waited".
  const latest = useRef<RemoteActivity | null>(activity);
  latest.current = activity;
  // Where the pointer (or focus) is resting, whether or not there is yet a
  // record to report, and the wait it has earned — as ONE record, because
  // "the pointer is here" and "an open is counting down for this operation"
  // are halves of a single fact. Held apart, one call site updated a half and
  // left the other armed: a forgotten trigger kept its timer and threw a card
  // at a pointer that had gone. `restOn` and `release` own the record's
  // lifetime; `arm` and `disarm` own its `wait`, and nothing else writes it.
  const resting = useRef<Resting | null>(null);
  // One tick per second, and only while the card is on screen — the readouts
  // it exists for ("no response for 2m 41s") are counted in seconds.
  const now = useSecondsClock(visible);

  /** Drop any wait counting down, leaving the trigger itself remembered. */
  const disarm = useCallback((): void => {
    const held = resting.current;
    if (held === null || held.wait === undefined) return;
    window.clearTimeout(held.wait.timer);
    held.wait = undefined;
  }, []);

  /** Forget the trigger entirely — and with it, anything armed from it. */
  const forgetTrigger = useCallback((): void => {
    resting.current?.release();
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
   *
   * Releasing takes the wait with it. The listener exists because `close()`
   * may never run, so anything only `close()` undid would be left armed.
   */
  const restOn = useCallback((target: HTMLElement): void => {
    if (resting.current?.target === target) return;
    resting.current?.release();
    const release = (): void => {
      target.removeEventListener("mouseleave", release);
      target.removeEventListener("blur", release);
      // Only this trigger's own record is ours to drop: the pointer may
      // already have been handed on to the chip beside us.
      if (resting.current?.target !== target) return;
      const wait = resting.current.wait;
      if (wait !== undefined) window.clearTimeout(wait.timer);
      resting.current = null;
    };
    resting.current = { target, release, wait: undefined };
    target.addEventListener("mouseleave", release);
    target.addEventListener("blur", release);
  }, []);

  useEffect(() => forgetTrigger, [forgetTrigger]);

  /** Open the card for the live record, once it is old enough to earn one. */
  const arm = useCallback(
    (target: HTMLElement): void => {
      const live = latest.current;
      // Nothing to report yet. The trigger is remembered, and the effect below
      // comes back here the moment a record arrives.
      if (live === null) return;
      disarm();
      const remaining =
        REMOTE_ACTIVITY_POPOVER_AFTER_MS - (Date.now() - live.startedAt);
      if (remaining <= 0) {
        show(target, <RemoteActivityCard activity={live} now={Date.now()} />);
        return;
      }
      const held = resting.current;
      // Only ever armed from the trigger the pointer is on, so that letting
      // that trigger go is all it takes to call the whole thing off.
      if (held === null || held.target !== target) return;
      const operationId = live.id;
      const timer = window.setTimeout(() => {
        if (resting.current?.target === target) resting.current.wait = undefined;
        const atFire = latest.current;
        if (atFire === null || atFire.id !== operationId) return;
        show(target, <RemoteActivityCard activity={atFire} now={Date.now()} />);
      }, remaining);
      held.wait = { operationId, timer };
    },
    [disarm, show]
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
    const held = resting.current;
    if (held === null) return;
    // A trigger torn out from under a stationary pointer never gets to say the
    // pointer left it, so drop it here rather than hold a detached node and
    // its listeners for the life of the hook.
    if (!held.target.isConnected) {
      forgetTrigger();
      return;
    }
    if (held.wait?.operationId === operationId) return;
    arm(held.target);
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
      scheduleHide();
    },
    node: tooltip.tooltipNode
  };
}
