import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import type { RemoteActivity } from "@pwrgit/shared";
import { announce } from "../../lib/announce";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { useSecondsClock } from "../../state/useRemoteActivity";
import { RemoteActivityCard } from "./RemoteActivityCard";
import type { RemoteActivityPhase } from "@pwrgit/shared";
import {
  activitySteps,
  formatElapsed,
  liveActivityView,
  remoteActivityMeter,
  remoteActivityTitle,
  settledActivityView,
  REMOTE_ACTIVITY_NARRATE_AFTER_MS,
  REMOTE_ACTIVITY_SETTLED_MS,
  type RemoteActivityOutcome,
  type RemoteActivityOutcomeStatus,
  type RemoteActivityScope,
  type RemoteActivityView
} from "./remote-activity";

/**
 * How old an operation must be before a *hover* will open its card.
 *
 * Not a hover dwell — the wait is measured from when the operation started, so
 * it is already satisfied for anything that has been running a while and such
 * a hover opens instantly.
 *
 * It only governs the hover path now, and that is the whole of its remaining
 * job: suppressing a card nobody asked for. A pointer can come to rest on a
 * toolbar button that then turns busy because a bulk sync or another window
 * started something — one sub-second operation per repository, each throwing a
 * card over the graph and taking it away again.
 *
 * It deliberately does NOT gate `pin`. A click is an ask, and the original
 * reason this number existed — that clicking Pull leaves the pointer inside
 * the button, so the spinner swap fires `mouseenter` under it — is answered by
 * pinning instead: the card is already open when that enter arrives, and the
 * enter finds it and does nothing.
 */
export const REMOTE_ACTIVITY_POPOVER_AFTER_MS = 1_200;

/**
 * Where the user's attention already is, asked of the DOM rather than waited
 * for as an event.
 *
 * `:hover` matches the whole hover chain, so a pointer resting on a button's
 * glyph still answers for the button. `:focus-visible` is the keyboard half
 * and is deliberately not `:focus`: clicking a button focuses it in Chromium
 * without making it focus-visible, so this cannot resurrect a card for a
 * pointer that has already moved away — measured, not assumed, in
 * `e2e/remote-activity.spec.ts`.
 *
 * Exported so the jsdom harness can stub exactly this query rather than
 * carrying its own copy of it.
 */
export const WHERE_THE_USER_IS = ":hover, :focus-visible";

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

/**
 * One click-opened session: what it hangs from, whose operation it is, and how
 * far that operation has got.
 *
 * `scope` is taken at the click rather than read off the live record, because
 * for the first tens of milliseconds — and for an operation short enough that
 * the renderer never sees a record at all — there is no record to read. It is
 * also what titles the receipt after `finish()` has deleted the record.
 */
type Pin = {
  /** Distinguishes one session from the next on the same button. */
  id: number;
  target: HTMLElement;
  scope: RemoteActivityScope;
  /** When the click happened — the elapsed fallback before a record exists. */
  startedAt: number;
  /** Set once the operation ends; the card becomes its receipt. */
  outcome: RemoteActivityOutcome | null;
};

/**
 * The countdown rail, as "how much is left" and "since when it has been
 * draining" — one record, because they are halves of one fact.
 *
 * Banking the elapsed time on pause and restarting from the banked value is
 * what keeps the JavaScript timer in step with the CSS animation that draws
 * it: both stop where they are and both resume from there.
 */
type Rail = { remaining: number; since: number | null };

/** What the caller reports when an operation ends. */
export type RemoteActivitySettlement = {
  status: RemoteActivityOutcomeStatus;
  /** The one sentence: "Fast-forwarded · local changes reapplied". */
  summary: string;
  /** Shown only when the live record left no Git output — an error body. */
  detail?: string;
};

export type RemoteActivityPopover = {
  /**
   * Wire to the action button's `onClick`. Opens the card for the operation
   * that click is about to start, and holds it until the user dismisses it or
   * a successful outcome's rail runs out.
   */
  pin: (target: HTMLElement, scope: RemoteActivityScope) => void;
  /**
   * The operation ended. Returns whether a pinned card took the outcome — the
   * caller uses that to decide whether a failure still needs a toast of its
   * own, so the same error is never reported twice.
   */
  settle: (settlement: RemoteActivitySettlement) => boolean;
  /**
   * Take the card off screen now. For the one case the dismissal rules do not
   * cover: something else — a modal — is about to own the window, and a status
   * card behind it would be a second thing to dismiss.
   */
  dismiss: () => void;
  /** Wire to the busy control's mouseenter/focus, passing `currentTarget`. */
  open: (target: HTMLElement) => void;
  /** Wire to mouseleave/blur; the pointer keeps a grace period to cross in. */
  close: () => void;
  /**
   * Move focus into the card's first control. Wire to Tab on the trigger and
   * swallow the key when it returns true — the card carries Cancel, and the
   * pointer's route into it (just move) has no keyboard equivalent.
   */
  focusFirst: () => boolean;
  /** A card is on screen, pinned or hovered. */
  showing: boolean;
  /**
   * Which operation the *pinned* card belongs to, or null when nothing is
   * pinned. The caller needs it because a pinned card hangs off whichever
   * control was clicked, which is not something the trigger wiring otherwise
   * knows — and a control that is not the anchor must not claim Tab.
   */
  pinnedKind: RemoteActivityScope["kind"] | null;
  node: ReactNode;
};

/**
 * The controls the card hangs from while an operation runs, in the order the
 * card would rather anchor to them. Handed in as refs because a trigger can
 * *become* one with the user already on it and no event to say so — see the
 * arming effect below.
 */
export type RemoteActivityTriggers = readonly RefObject<HTMLElement | null>[];

/**
 * The card before the operation is old enough to narrate — one stable line.
 *
 * It covers the whole quiet period, from the click through main's first words
 * about the operation, and says the same thing throughout. That is the point:
 * below the threshold the card has exactly two states, this one and its
 * receipt.
 *
 * The record is deliberately NOT read for the line. `remoteActivityStatus` IS
 * the per-phase narration — "Fetching updates", "Preparing local changes",
 * "Fast-forwarding and checking out files", "Reapplying local changes" — and
 * every `setPhase` publishes past the 400ms throttle, so a 620ms pull put four
 * sentences on screen inside six tenths of a second. Gating the step list alone
 * left that same churn arriving by the other door.
 *
 * What the record IS read for is the operation itself: its id and canceling
 * flag, so Cancel is drawn from the moment there is something to stop rather
 * than appearing when the narration starts, and its output tail, which rides
 * inside a collapsed disclosure and so changes nothing about the card's shape.
 */
function startingView(
  pin: Pin,
  now: number,
  activity: RemoteActivity | null = null
): RemoteActivityView {
  return {
    operationId: activity?.id ?? null,
    title: remoteActivityTitle(pin.scope),
    elapsed: formatElapsed(now - pin.startedAt),
    statusLabel: "Starting…",
    statusTone: "muted",
    // No meter: it mounts and unmounts with Git's first and last progress
    // line, and a block that appears for a third of a second is churn, not
    // information.
    meter: null,
    percent: null,
    // Nor is its space reserved: an empty transfer block here would make this
    // card TALLER than the one-row step list that replaces it at the
    // threshold, and turn the card's one honest transition into a shrink.
    meterSlot: false,
    // No command either. It changes with every Git invocation rather than
    // every phase — a pull runs eight of them — and each is a different
    // number of wrapped lines under the rest of the card.
    command: null,
    output: activity?.tail ?? [],
    // Nothing to list yet: the card falls back to its status line, which is
    // the whole of what "Starting…" has to say.
    steps: [],
    canceling: activity?.canceling ?? null,
    settled: null
  };
}

/**
 * The status card, hung off whichever toolbar control the operation belongs to.
 *
 * Two ways in, one card. **A click pins it**: no gate, no hover requirement,
 * and it stays through the operation and past it — a success drains a rail and
 * leaves, a failure stands until dismissed. **A hover opens it un-pinned**, for
 * an operation against this checkout that something else started, where there
 * was no click to pin from; that one still answers to the pointer and to the
 * age gate above.
 *
 * Interactive, because the card carries Cancel, Logs and Copy: the pointer has
 * to be able to travel from the trigger into it.
 */
export function useRemoteActivityPopover(
  activity: RemoteActivity | null,
  triggers: RemoteActivityTriggers = []
): RemoteActivityPopover {
  // Where the pointer is inside the card. Owned by the hook rather than by
  // handlers on the content, because the card's padding ring belongs to the
  // surface: a pointer resting there is on the card by any reading a user
  // would give it.
  const [within, setWithin] = useState(false);
  const tooltip = useViewportTooltip("remote-activity-popover", {
    interactive: true,
    label: "Git operation status",
    onPointerWithin: setWithin
  });
  const { show, update, hide, scheduleHide, setSticky, focusFirst, visible } =
    tooltip;
  // The deferred open fires from a timer, long after the render that armed it.
  // Read the live record through a ref so the timer can tell "still running"
  // from "finished while I waited".
  const latest = useRef<RemoteActivity | null>(activity);
  latest.current = activity;
  // The last record this pin's operation published. `settle` runs from an IPC
  // response that races main's own `finish()` broadcast, so by then `activity`
  // is usually already null — and Git's last words, which are the whole point
  // of a failed card, only exist here.
  const lastSeen = useRef<RemoteActivity | null>(null);
  // Where the pointer (or focus) is resting, whether or not there is yet a
  // record to report, and the wait it has earned — as ONE record, because
  // "the pointer is here" and "an open is counting down for this operation"
  // are halves of a single fact. Held apart, one call site updated a half and
  // left the other armed: a forgotten trigger kept its timer and threw a card
  // at a pointer that had gone. `restOn` and `release` own the record's
  // lifetime; `arm` and `disarm` own its `wait`, and nothing else writes it.
  const resting = useRef<Resting | null>(null);
  // Latched: the caller rebuilds this array every render, and the only thing
  // that reads it is an effect keyed on the operation.
  const triggersRef = useRef<RemoteActivityTriggers>(triggers);
  triggersRef.current = triggers;

  // The pinned session, in state because it is rendered and in a ref because
  // `settle` reads it from an async continuation. `setPin` is the only writer
  // of either, so the two cannot disagree.
  const [pin, setPinState] = useState<Pin | null>(null);
  const pinRef = useRef<Pin | null>(null);
  const setPin = useCallback((next: Pin | null): void => {
    pinRef.current = next;
    setPinState(next);
  }, []);
  const pinCount = useRef(0);
  // Every phase this pin's operation has been observed in, in order and
  // deduplicated — the card's step list, and the receipt's substance.
  //
  // In state so a new phase re-renders (a row appearing IS the update worth
  // rendering), and in a ref because `settle` reads it from an async
  // continuation, exactly as `pin` is. `setSeen` is the only writer of either.
  const [seen, setSeenState] = useState<readonly RemoteActivityPhase[]>([]);
  const seenRef = useRef<readonly RemoteActivityPhase[]>([]);
  const setSeen = useCallback((next: readonly RemoteActivityPhase[]): void => {
    seenRef.current = next;
    setSeenState(next);
  }, []);
  /** An explicit hold: the user clicked the card, or tabbed into it. Named
   *  apart from the `held` locals below, which are the rested-on trigger. */
  const [railHeld, setRailHeld] = useState(false);
  const rail = useRef<Rail>({ remaining: REMOTE_ACTIVITY_SETTLED_MS, since: null });
  const [reduced] = useState(prefersReducedMotion);
  // Which pin session the tooltip is currently showing, so a re-render updates
  // the card in place and only a new session re-anchors it.
  const shownFor = useRef<number | null>(null);
  // Whether the card has actually been on screen during this session. Escape,
  // a window blur and a scroll all take it away through `useViewportTooltip`
  // without telling us, and a session whose card is gone must not go on
  // holding the pointer hostage — but the render right after `pin()` is also
  // not visible yet, and that one is not a dismissal.
  const wasVisible = useRef(false);

  // One tick per second, and only while the card is on screen — the readouts
  // it exists for ("no response for 2m 41s", and the rail's remaining steps
  // under reduced motion) are counted in seconds.
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

  /** End the pinned session and take the card off screen. */
  const dismiss = useCallback((): void => {
    wasVisible.current = false;
    setPin(null);
    // No `setSticky(false)` — `hide()` clears the flag itself, and that is
    // part of what it promises rather than an accident of how it is written.
    hide();
  }, [hide, setPin]);

  const pinCard = useCallback(
    (target: HTMLElement, scope: RemoteActivityScope): void => {
      // A pin supersedes anything the pointer had earned: the two paths render
      // into one tooltip, and a hover left armed would re-show a stale card
      // the moment this session ended.
      forgetTrigger();
      lastSeen.current = null;
      setSeen([]);
      rail.current = { remaining: REMOTE_ACTIVITY_SETTLED_MS, since: null };
      wasVisible.current = false;
      shownFor.current = null;
      setRailHeld(false);
      setWithin(false);
      pinCount.current += 1;
      setPin({
        id: pinCount.current,
        target,
        scope,
        startedAt: Date.now(),
        outcome: null
      });
      setSticky(true);
    },
    [forgetTrigger, setPin, setSeen, setSticky]
  );

  const settle = useCallback(
    (settlement: RemoteActivitySettlement): boolean => {
      const open = pinRef.current;
      if (open === null) return false;
      const record = lastSeen.current;
      const detail = (settlement.detail ?? "")
        .split("\n")
        .filter((line) => line.trim() !== "");
      setPin({
        ...open,
        outcome: {
          ...open.scope,
          status: settlement.status,
          startedAt: record?.startedAt ?? open.startedAt,
          endedAt: Date.now(),
          summary: settlement.summary,
          command: record?.command ?? null,
          // What it did, whether or not the live card ever narrated it. Below
          // the narration threshold nothing was drawn — and this is still the
          // full list, which is how a sub-second pull ends up answering
          // "what happened" without ever having churned.
          // The last phase is passed as the *current* one so a failure can
          // resolve it: `settledActivityView` turns it into "✓ Fetched" on a
          // success and leaves it marked as where the operation stopped
          // otherwise. Marking every step done unconditionally made a failed
          // fetch report "✓ Fetched", which is the opposite of the truth.
          steps: activitySteps(seenRef.current, record?.phase ?? null),
          // Git's own words first; the error body only when Git wrote nothing
          // at all, which is exactly the wedged case the card exists for.
          output:
            record !== null && record.tail.length > 0
              ? [...record.tail]
              : detail
        }
      });
      // One utterance, not a counter — which is why the settled card may be
      // announced at all where the running one deliberately is not. The sync
      // chip beside it is the live region for "what is happening"; this is the
      // single sentence for "what happened".
      announce(`${remoteActivityTitle(open.scope)} — ${settlement.summary}`);
      // The receipt's countdown begins now, so it begins un-held. A click
      // that landed while the operation was still running — Copy, or Cancel
      // itself — was not a click on a timer, because there was no timer yet;
      // carrying it forward would hand the user a receipt that never goes
      // away and no countdown they could have seen to stop. The pointer is
      // the other half and is deliberately not reset: `within` is where it
      // is right now, and a card under the pointer still waits.
      setRailHeld(false);
      rail.current = { remaining: REMOTE_ACTIVITY_SETTLED_MS, since: null };
      return true;
    },
    [setPin]
  );

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
      const showHover = (record: RemoteActivity): void => {
        show(
          target,
          <RemoteActivityCard view={liveActivityView(record, Date.now())} />
        );
      };
      if (remaining <= 0) {
        showHover(live);
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
        // A pin that arrived while this was counting down owns the card now.
        if (pinRef.current !== null) return;
        showHover(atFire);
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
  //
  // And a hover that never lands at all must not be lost either.
  //
  // The race above at least produces an event. Fetch produces none: it draws
  // the same `<RefreshGlyph/>` busy or idle — the arrow spins in place — so
  // nothing under the pointer is replaced, Chromium has no reason to
  // re-resolve hover, and the pointer that clicked is already inside the
  // button when it becomes a trigger. The keyboard fails the same way from
  // the other side: the click's or Enter's `focusin` lands before the button
  // is busy, and no second focus event follows. There is nothing to remember
  // because nothing was ever reported — so ask the DOM where the user is
  // instead of waiting to be told.
  //
  // Resting on what it finds, rather than arming it directly, is what makes
  // the answer hold: `restOn` puts real `mouseleave`/`blur` listeners on the
  // element, so a user who does move away calls the whole thing off exactly
  // as if they had arrived by event.
  //
  // None of it runs while a card is pinned. The click already answered the
  // question this machinery exists to answer, and re-arming underneath it
  // would leave a hover primed to reopen a finished operation's card the
  // moment the pinned one was dismissed.
  const operationId = activity?.id ?? null;
  useEffect(() => {
    if (operationId === null || visible || pin !== null) return;
    if (resting.current === null) {
      const found = triggersRef.current
        .map((trigger) => trigger.current)
        .find((element) => element !== null && element.matches(WHERE_THE_USER_IS));
      if (found === undefined || found === null) return;
      restOn(found);
    }
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
  }, [arm, forgetTrigger, operationId, pin, restOn, visible]);

  // Keep the pinned card's own record of the operation, so the receipt can
  // still quote Git after `finish()` has taken the record away. In an effect
  // rather than during render: a render React discards must not be what
  // decides which Git output a failure gets to show.
  useEffect(() => {
    if (activity === null) return;
    if (activity.kind !== pinRef.current?.scope.kind) return;
    lastSeen.current = activity;
    const phase = activity.phase;
    // Append-only and deduplicated: a phase Git re-enters (a pull pops its
    // stash in two places) is one step, not two rows, and a row once written
    // is never moved.
    if (!seenRef.current.includes(phase)) {
      setSeen([...seenRef.current, phase]);
    }
  }, [activity, setSeen]);

  // The hover card's own refresh, and its ending.
  //
  // The pinned half is redrawn by the effect further down, which bails when
  // there is no pin — so without this one a hover-opened card is a snapshot
  // of the instant it opened. That is the whole of what it is for: the
  // elapsed readout, the transfer meter and "no Git output for 2m 41s" are
  // the difference between a fetch that is working and one that is wedged,
  // and a frozen card draws the wedged one as healthy.
  //
  // `activity === null` is the other half. A hover card leaves with the
  // pointer, but the pointer's exit is reported by `close()`, a React prop on
  // a control that STOPS being a trigger the moment its operation ends — so
  // an operation that finishes under a resting pointer takes its own
  // dismissal away with it. The record going is the dismissal here.
  useEffect(() => {
    if (!visible || pin !== null) return;
    if (activity === null) {
      hide();
      return;
    }
    update(<RemoteActivityCard view={liveActivityView(activity, now)} />);
  }, [activity, hide, now, pin, update, visible]);

  // What the pinned session is currently showing: its receipt if it has one,
  // the live record while the operation runs, and a placeholder for the gap
  // between the click and main's first word.
  // Below the threshold the card shows one stable line and then its receipt —
  // two states rather than a five-redraw play-by-play of something that was
  // over before the first frame could be read. The steps go on being recorded
  // throughout, so the receipt is the same either way.
  const narrating =
    pin !== null && now - pin.startedAt >= REMOTE_ACTIVITY_NARRATE_AFTER_MS;
  const pinView: RemoteActivityView | null =
    pin === null
      ? null
      : pin.outcome !== null
        ? settledActivityView(pin.outcome)
        : activity === null || activity.kind !== pin.scope.kind
          ? startingView(pin, now)
          : narrating
            ? liveActivityView(
                activity,
                now,
                activitySteps(seen, activity.phase, {
                  detail: remoteActivityMeter(activity),
                  percent: activity.progress?.percent ?? null
                })
              )
            : startingView(pin, now, activity);

  // A failure has no rail at all: a bar that is not draining cannot be
  // mistaken for one that is, and nothing but the user ends it.
  const draining =
    pin !== null && pin.outcome !== null && pin.outcome.status !== "error";
  const paused = within || railHeld;
  const railLeft = (): number => {
    const { remaining, since } = rail.current;
    return Math.max(0, since === null ? remaining : remaining - (now - since));
  };

  useEffect(() => {
    if (!draining || paused) return;
    const from = Date.now();
    rail.current = { remaining: rail.current.remaining, since: from };
    const timer = window.setTimeout(dismiss, rail.current.remaining);
    return () => {
      window.clearTimeout(timer);
      rail.current = {
        remaining: Math.max(0, rail.current.remaining - (Date.now() - from)),
        since: null
      };
    };
  }, [dismiss, draining, paused]);

  // Draw (or redraw) the pinned card. `show` anchors a new session; every
  // later render of the same one is an `update`, which keeps the card where it
  // was placed rather than letting it walk as its content changes height.
  useEffect(() => {
    if (pin === null || pinView === null) {
      shownFor.current = null;
      return;
    }
    const content = (
      <>
        {/* Capture rather than bubble so a click on a control inside the card
            still counts as "the user is using this" — and so does the focus a
            Tab handoff lands, which is the keyboard's version of the same
            gesture. */}
        <div
          className="remote-activity__pinned"
          onClickCapture={() => setRailHeld(true)}
          onFocusCapture={() => setRailHeld(true)}
        >
          <RemoteActivityCard view={pinView} onClose={dismiss} />
        </div>
        {draining && (
          <span
            className="remote-activity__rail"
            aria-hidden="true"
            data-paused={paused ? "true" : undefined}
            // The blanket `prefers-reduced-motion` rule in app.css is
            // `animation: none !important`, which would leave a full rail on a
            // card that then vanished unannounced. Stepping `scaleX` off the
            // seconds clock the card already runs keeps the information and
            // drops the motion — four discrete steps, not a sweep.
            style={
              reduced
                ? {
                    transform: `scaleX(${(
                      railLeft() / REMOTE_ACTIVITY_SETTLED_MS
                    ).toFixed(3)})`
                  }
                : { animationDuration: `${REMOTE_ACTIVITY_SETTLED_MS}ms` }
            }
          />
        )}
      </>
    );
    if (shownFor.current === pin.id) {
      update(content);
      return;
    }
    shownFor.current = pin.id;
    show(pin.target, content);
    // `pinView` and `railLeft()` are rebuilt every render and derive from
    // exactly `pin`, `activity` and `now`, all listed — naming them here would
    // re-run this for every render and buy nothing.
    // `railHeld` is deliberately absent: `paused` is `within || railHeld`, so
    // anything it could change here has already changed `paused`.
  }, [
    activity,
    dismiss,
    draining,
    now,
    paused,
    pin,
    reduced,
    seen,
    show,
    update
  ]);

  // A click anywhere else dismisses the card, and the click still lands where
  // it was aimed — nothing here calls `preventDefault`. Capture phase so a
  // surface that stops propagation cannot strand the card on screen; mousedown
  // rather than click so it goes at the start of the gesture, the way every
  // other dismissable overlay in the app behaves.
  //
  // Pressing the trigger again is not "elsewhere": the button's own handler
  // either starts a new operation (and re-pins) or is inert because one is
  // already running, and neither should take the status away.
  useEffect(() => {
    if (pin === null) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        target instanceof Element &&
        target.closest(".remote-activity-popover") !== null
      ) {
        return;
      }
      if (pin.target.contains(target)) return;
      dismiss();
    };
    window.addEventListener("mousedown", onPointerDown, true);
    return () => window.removeEventListener("mousedown", onPointerDown, true);
  }, [dismiss, pin]);

  // Escape, a window blur and a scroll all hide the card from inside
  // `useViewportTooltip` without routing through `dismiss`. Left alone, the
  // session would go on believing it owned a card that is no longer there.
  useEffect(() => {
    if (visible) {
      wasVisible.current = true;
      return;
    }
    if (!wasVisible.current) return;
    if (pinRef.current !== null) dismiss();
  }, [dismiss, visible]);

  // The hover half of the card, unchanged — except that it stands down
  // entirely while a click owns the surface.
  return {
    pin: pinCard,
    open: (target) => {
      if (pinRef.current !== null) return;
      restOn(target);
      arm(target);
    },
    close: () => {
      if (pinRef.current !== null) return;
      forgetTrigger();
      scheduleHide();
    },
    settle,
    dismiss,
    focusFirst,
    showing: visible,
    pinnedKind: pin?.scope.kind ?? null,
    node: tooltip.tooltipNode
  };
}
