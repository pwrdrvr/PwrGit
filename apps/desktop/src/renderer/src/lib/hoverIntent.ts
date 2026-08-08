import { useCallback, useEffect, useMemo, useRef } from "react";

/** A cold trigger must be dwelled on before its card appears. */
export const HOVER_INTENT_DWELL_MS = 300;
/** Once a card has been on screen, neighbouring triggers respond quickly —
 * browsing history row by row should not feel like waiting. */
export const HOVER_INTENT_WARM_DWELL_MS = 90;
/** How long after a card closes the pointer is still considered "browsing". */
export const HOVER_INTENT_WARM_WINDOW_MS = 700;
/** px/ms below which the pointer counts as aiming rather than travelling.
 * A whip across the window runs 2–5 px/ms; the tail of a deliberate move is
 * far slower than this. */
export const HOVER_INTENT_SETTLE_PX_PER_MS = 0.45;
/** A pointer that has not strayed this far from where it entered the trigger
 * is aiming, however fast it shakes. Speed alone would exclude anyone whose
 * hand does not hold still: a 10px tremor at 20ms intervals reads as
 * 0.5 px/ms — above the settle threshold — and would never open a card. */
export const HOVER_INTENT_JITTER_PX = 10;
/** A pointer device streams moves while the hand is moving. A gap this long
 * means it stopped — not that its last hop is still in flight. */
export const POINTER_STOPPED_MS = 120;
/** How often an armed trigger re-checks the pointer. */
const POLL_MS = 40;

export type PointerSample = { x: number; y: number; t: number };

/** The pointer's current speed in px/ms, measured over its last hop and
 * decaying to zero once the device goes quiet. */
export function pointerSpeedAt({
  prev,
  last,
  now
}: {
  prev?: PointerSample;
  last?: PointerSample;
  now: number;
}): number {
  if (prev === undefined || last === undefined) return 0;
  if (now - last.t > POINTER_STOPPED_MS) return 0;
  const distance = Math.hypot(last.x - prev.x, last.y - prev.y);
  return distance / Math.max(1, now - prev.t);
}

/** Whether a trigger hovered for `dwellMs` should open its card yet. The
 * pointer must have lingered *and* be aiming rather than passing through.
 *
 * "Aiming" is satisfied two ways, and either is enough: the pointer has
 * stayed within `HOVER_INTENT_JITTER_PX` of where it entered the trigger
 * (a shaking hand that is going nowhere), or it has slowed below the settle
 * threshold (a steady hand still drifting). A sweep satisfies neither — it is
 * both fast and travelling away from where it started — so requiring only one
 * costs nothing in suppression while excluding nobody. */
export function hoverIntentVerdict({
  dwellMs,
  speed,
  driftPx,
  warm
}: {
  dwellMs: number;
  speed: number;
  /** Distance from where the pointer entered this trigger. */
  driftPx: number;
  warm: boolean;
}): "open" | "wait" {
  const aiming =
    driftPx <= HOVER_INTENT_JITTER_PX ||
    speed <= HOVER_INTENT_SETTLE_PX_PER_MS;
  if (!aiming) return "wait";
  const required = warm ? HOVER_INTENT_WARM_DWELL_MS : HOVER_INTENT_DWELL_MS;
  return dwellMs >= required ? "open" : "wait";
}

/**
 * Hover-intent state for pointer-triggered cards. Callers feed it pointer
 * samples, arm it when a trigger is entered, and poll it; it answers `true`
 * exactly once, when the hover looks deliberate. Timer-free so the decision
 * logic can be tested without a DOM.
 */
export class HoverIntentGate {
  private prev: PointerSample | undefined;
  private last: PointerSample | undefined;
  private armedAt: number | undefined;
  /** Where the pointer was when it entered the current trigger. */
  private armedFrom: PointerSample | undefined;
  /** Identifies the current arming, so a poller left over from a trigger the
   * pointer has already left cannot open someone else's card. */
  private armedSeq = 0;
  private opened = false;
  /** When a card last stopped being on screen. */
  private wentColdAt = Number.NEGATIVE_INFINITY;

  track(sample: PointerSample): void {
    this.prev = this.last;
    this.last = sample;
  }

  speedAt(now: number): number {
    return pointerSpeedAt({
      ...(this.prev === undefined ? {} : { prev: this.prev }),
      ...(this.last === undefined ? {} : { last: this.last }),
      now
    });
  }

  isWarm(now: number): boolean {
    return this.opened || now - this.wentColdAt <= HOVER_INTENT_WARM_WINDOW_MS;
  }

  /** How far the pointer has strayed since it entered the current trigger.
   * Unarmed, or armed before any pointer sample, counts as no drift. */
  driftAt(): number {
    if (this.armedFrom === undefined || this.last === undefined) return 0;
    return Math.hypot(
      this.last.x - this.armedFrom.x,
      this.last.y - this.armedFrom.y
    );
  }

  /** Returns a token identifying this arming; pass it back to `poll`. */
  arm(now: number): number {
    this.armedAt = now;
    this.armedFrom = this.last;
    this.armedSeq += 1;
    return this.armedSeq;
  }

  poll(now: number, seq?: number): boolean {
    if (seq !== undefined && seq !== this.armedSeq) return false;
    if (this.armedAt === undefined || this.opened) return false;
    const verdict = hoverIntentVerdict({
      dwellMs: now - this.armedAt,
      speed: this.speedAt(now),
      driftPx: this.driftAt(),
      warm: this.isWarm(now)
    });
    if (verdict === "wait") return false;
    this.opened = true;
    return true;
  }

  /** Focus and click bypass the gate — the intent is already explicit. */
  openNow(now: number): void {
    this.armedAt = now;
    this.armedFrom = this.last;
    this.opened = true;
  }

  /** The pointer left the trigger: drop any pending open, and start the warm
   * window if a card actually made it onto the screen. */
  disarm(now: number): void {
    if (this.opened) this.wentColdAt = now;
    this.armedAt = undefined;
    this.armedFrom = undefined;
    this.opened = false;
  }

  /** A card left the screen. An interactive card outlives the hover that
   * opened it — the user is still browsing while they read it, so warmth runs
   * from here, not from the moment the pointer left the trigger. */
  markCardClosed(now: number): void {
    this.wentColdAt = now;
  }
}

/** One gate for the whole window: warmth is a property of the user's pass
 * through the UI, not of any single row, and only one trigger is hovered at a
 * time. */
const sharedGate = new HoverIntentGate();

/** One passive listener feeds every armed trigger, however many rows are
 * mounted. Attached while at least one hook is alive. */
let listeners = 0;
const onPointerMove = (event: MouseEvent): void => {
  sharedGate.track({ x: event.clientX, y: event.clientY, t: Date.now() });
};

function trackPointer(): () => void {
  listeners += 1;
  if (listeners === 1) {
    window.addEventListener("mousemove", onPointerMove, { passive: true });
  }
  return () => {
    listeners -= 1;
    if (listeners === 0) {
      window.removeEventListener("mousemove", onPointerMove);
    }
  };
}

export type HoverIntent = {
  /** Enter a hover trigger: `open` runs only if the hover proves deliberate. */
  arm: (open: () => void) => void;
  /** Leave the trigger, dropping any pending open. */
  cancel: () => void;
  /** Open right now (focus, click) and keep the gate warm. */
  immediate: (open: () => void) => void;
  /** Report that a card left the screen, so warmth measures from there. */
  cardClosed: () => void;
};

/** The pointer/keyboard handlers a gated hover trigger needs. Both the SHA
 * chip and the PR chip wire exactly this, so the routing — hover defers, focus
 * and click do not, leaving always cancels — is written and tested once. */
export function hoverIntentHandlers({
  intent,
  show,
  hide
}: {
  intent: HoverIntent;
  show: (target: HTMLElement) => void;
  hide: () => void;
}): {
  onMouseEnter: (target: HTMLElement) => void;
  onMouseLeave: () => void;
  onFocus: (target: HTMLElement) => void;
  onBlur: () => void;
  /** Bypass the gate — for a click whose own action is to reveal the popup. */
  showNow: (target: HTMLElement) => void;
  /** Drop any pending open and dismiss — for a click that does something else
   *  (opening a PR in the browser) and should take its tooltip with it. */
  leave: () => void;
} {
  const showNow = (target: HTMLElement): void =>
    intent.immediate(() => show(target));
  const leave = (): void => {
    intent.cancel();
    hide();
  };
  return {
    onMouseEnter: (target) => intent.arm(() => show(target)),
    onMouseLeave: leave,
    onFocus: showNow,
    onBlur: leave,
    showNow,
    leave
  };
}

/**
 * Gate a hover-triggered popup on intent, so a pointer thrown across the
 * window does not leave a trail of cards behind it. Keyboard and click paths
 * stay instant.
 */
export function useHoverIntent(gate: HoverIntentGate = sharedGate): HoverIntent {
  const timerRef = useRef<number | undefined>(undefined);

  const stopPolling = useCallback((): void => {
    if (timerRef.current === undefined) return;
    window.clearInterval(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const cancel = useCallback((): void => {
    stopPolling();
    gate.disarm(Date.now());
  }, [gate, stopPolling]);

  const arm = useCallback((open: () => void): void => {
    stopPolling();
    const seq = gate.arm(Date.now());
    timerRef.current = window.setInterval(() => {
      if (!gate.poll(Date.now(), seq)) return;
      stopPolling();
      open();
    }, POLL_MS);
  }, [gate, stopPolling]);

  const immediate = useCallback((open: () => void): void => {
    stopPolling();
    gate.openNow(Date.now());
    open();
  }, [gate, stopPolling]);

  const cardClosed = useCallback((): void => {
    gate.markCardClosed(Date.now());
  }, [gate]);

  useEffect(() => {
    const untrack = trackPointer();
    return () => {
      untrack();
      stopPolling();
    };
  }, [stopPolling]);

  // Stable identity: callers put this in effect dependencies, and a fresh
  // object each render would re-run those effects on every clock tick.
  return useMemo(
    () => ({ arm, cancel, immediate, cardClosed }),
    [arm, cancel, immediate, cardClosed]
  );
}
