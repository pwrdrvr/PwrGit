import { describe, expect, it } from "vitest";
import {
  HOVER_INTENT_DWELL_MS,
  HOVER_INTENT_SETTLE_PX_PER_MS,
  HOVER_INTENT_WARM_DWELL_MS,
  HOVER_INTENT_WARM_WINDOW_MS,
  HoverIntentGate,
  POINTER_STOPPED_MS,
  hoverIntentHandlers,
  hoverIntentVerdict,
  pointerSpeedAt
} from "./hoverIntent";

/** A mouse being whipped across the window: ~3 px/ms, sampled like a real
 * pointer device. */
const WHIP_STEP_PX = 24;
const SAMPLE_MS = 8;

describe("pointerSpeedAt", () => {
  it("measures the last hop in px/ms", () => {
    expect(
      pointerSpeedAt({
        prev: { x: 100, y: 300, t: 1000 },
        last: { x: 124, y: 300, t: 1008 },
        now: 1008
      })
    ).toBeCloseTo(3, 5);
  });

  it("treats a pointer that has stopped emitting moves as stationary", () => {
    // Real pointers stream moves continuously; a gap means the hand stopped.
    // Without this, one long jump would keep the pointer "fast" for a second.
    expect(
      pointerSpeedAt({
        prev: { x: 100, y: 300, t: 1000 },
        last: { x: 700, y: 300, t: 1001 },
        now: 1400
      })
    ).toBe(0);
  });

  it("reports no speed before any pointer sample arrives", () => {
    expect(pointerSpeedAt({ now: 1000 })).toBe(0);
  });

  it("still trusts the last hop right up to the stopped threshold", () => {
    // One millisecond either side of POINTER_STOPPED_MS: the sample is live
    // until the gap exceeds it, then the pointer counts as stationary.
    const hop = {
      prev: { x: 100, y: 300, t: 1000 },
      last: { x: 160, y: 300, t: 1010 }
    };
    expect(
      pointerSpeedAt({ ...hop, now: 1010 + POINTER_STOPPED_MS })
    ).toBeGreaterThan(0);
    expect(
      pointerSpeedAt({ ...hop, now: 1010 + POINTER_STOPPED_MS + 1 })
    ).toBe(0);
  });
});

describe("hoverIntentVerdict", () => {
  it("waits while the pointer is still travelling, however long it has been over the target", () => {
    expect(
      hoverIntentVerdict({
        dwellMs: HOVER_INTENT_DWELL_MS * 4,
        speed: 3,
        warm: false
      })
    ).toBe("wait");
  });

  it("waits for the dwell even once the pointer has settled", () => {
    expect(
      hoverIntentVerdict({
        dwellMs: HOVER_INTENT_DWELL_MS - 1,
        speed: 0,
        warm: false
      })
    ).toBe("wait");
  });

  it("opens for a settled pointer past the dwell", () => {
    expect(
      hoverIntentVerdict({ dwellMs: HOVER_INTENT_DWELL_MS, speed: 0, warm: false })
    ).toBe("open");
  });

  it("treats the settle threshold itself as settled", () => {
    // The boundary a future tuner will move: at the threshold it opens, one
    // increment above it waits.
    expect(
      hoverIntentVerdict({
        dwellMs: HOVER_INTENT_DWELL_MS,
        speed: HOVER_INTENT_SETTLE_PX_PER_MS,
        warm: false
      })
    ).toBe("open");
    expect(
      hoverIntentVerdict({
        dwellMs: HOVER_INTENT_DWELL_MS,
        speed: HOVER_INTENT_SETTLE_PX_PER_MS + 0.01,
        warm: false
      })
    ).toBe("wait");
  });

  it("opens sooner while the user is already browsing cards", () => {
    expect(
      hoverIntentVerdict({
        dwellMs: HOVER_INTENT_WARM_DWELL_MS,
        speed: 0,
        warm: true
      })
    ).toBe("open");
    expect(
      hoverIntentVerdict({
        dwellMs: HOVER_INTENT_WARM_DWELL_MS,
        speed: 0,
        warm: false
      })
    ).toBe("wait");
  });
});

describe("HoverIntentGate", () => {
  it("never opens a card for a pointer whipped across the graph", () => {
    const gate = new HoverIntentGate();
    let t = 1000;
    let x = 100;
    let armed = false;
    let opened = false;

    // The sweep crosses one SHA chip every third sample: each row arms on
    // enter and disarms on leave, exactly as the pointer flies over it.
    for (let i = 0; i < 60; i += 1) {
      t += SAMPLE_MS;
      x += WHIP_STEP_PX;
      gate.track({ x, y: 300, t });
      if (i % 3 === 0) {
        if (armed) gate.disarm(t);
        gate.arm(t);
        armed = true;
      }
      if (gate.poll(t)) opened = true;
    }

    expect(opened).toBe(false);
  });

  it("opens once the pointer settles on a trigger", () => {
    const gate = new HoverIntentGate();
    let t = 1000;
    for (let i = 0; i < 10; i += 1) {
      t += SAMPLE_MS;
      gate.track({ x: 100 + i * WHIP_STEP_PX, y: 300, t });
    }
    // The pointer lands on the chip and stops: no further samples arrive.
    gate.arm(t);

    expect(gate.poll(t + HOVER_INTENT_DWELL_MS - 20)).toBe(false);
    expect(gate.poll(t + HOVER_INTENT_DWELL_MS + 20)).toBe(true);
    // The open is a one-shot; polling again must not re-fire it.
    expect(gate.poll(t + HOVER_INTENT_DWELL_MS + 60)).toBe(false);
  });

  it("opens for a slow deliberate glide that never fully stops", () => {
    const gate = new HoverIntentGate();
    let t = 1000;
    gate.track({ x: 200, y: 300, t });
    gate.arm(t);
    let opened = false;
    // 1px every 20ms — a hand resting on the target, not travelling.
    for (let i = 1; i <= 30; i += 1) {
      t += 20;
      gate.track({ x: 200 + i, y: 300, t });
      if (gate.poll(t)) opened = true;
    }

    expect(opened).toBe(true);
  });

  it("forgets a pending open when the pointer leaves the trigger", () => {
    const gate = new HoverIntentGate();
    const t = 1000;
    gate.track({ x: 200, y: 300, t });
    gate.arm(t);
    gate.disarm(t + 40);

    expect(gate.poll(t + HOVER_INTENT_DWELL_MS * 2)).toBe(false);
  });

  it("stays warm while the user moves from one card to the next row", () => {
    const gate = new HoverIntentGate();
    let t = 1000;
    gate.track({ x: 200, y: 300, t });
    gate.arm(t);
    expect(gate.poll(t + HOVER_INTENT_DWELL_MS)).toBe(true);

    // Card read, pointer moved down to the next SHA chip and stopped.
    t += 2000;
    gate.disarm(t);
    gate.track({ x: 200, y: 340, t });
    gate.arm(t);

    expect(gate.poll(t + HOVER_INTENT_WARM_DWELL_MS + 5)).toBe(true);
  });

  it("keeps warmth running while an interactive card is being read", () => {
    const gate = new HoverIntentGate();
    let t = 1000;
    gate.track({ x: 200, y: 300, t });
    gate.arm(t);
    expect(gate.poll(t + HOVER_INTENT_DWELL_MS)).toBe(true);

    // Pointer leaves the trigger for the card itself, which stays open while
    // the user reads it for far longer than the warm window.
    t += HOVER_INTENT_DWELL_MS;
    gate.disarm(t);
    t += HOVER_INTENT_WARM_WINDOW_MS * 5;
    gate.markCardClosed(t);

    // Moving straight on to the next row is still browsing, not a fresh start.
    gate.track({ x: 200, y: 340, t });
    gate.arm(t);
    expect(gate.poll(t + HOVER_INTENT_WARM_DWELL_MS + 5)).toBe(true);
  });

  it("goes cold again once the user has stopped browsing cards", () => {
    const gate = new HoverIntentGate();
    let t = 1000;
    gate.track({ x: 200, y: 300, t });
    gate.arm(t);
    expect(gate.poll(t + HOVER_INTENT_DWELL_MS)).toBe(true);
    t += HOVER_INTENT_DWELL_MS;
    gate.disarm(t);

    t += 5000;
    gate.track({ x: 200, y: 340, t });
    gate.arm(t);

    expect(gate.poll(t + HOVER_INTENT_WARM_DWELL_MS + 5)).toBe(false);
    expect(gate.poll(t + HOVER_INTENT_DWELL_MS + 5)).toBe(true);
  });

  it("ignores a poll left over from a trigger the pointer has left", () => {
    const gate = new HoverIntentGate();
    const t = 1000;
    gate.track({ x: 200, y: 300, t });
    const leftBehind = gate.arm(t);
    gate.arm(t + 10);

    expect(gate.poll(t + HOVER_INTENT_DWELL_MS * 2, leftBehind)).toBe(false);
  });

  it("goes cold when a card closed long enough ago", () => {
    const gate = new HoverIntentGate();
    let t = 1000;
    gate.markCardClosed(t);
    t += HOVER_INTENT_WARM_WINDOW_MS + 1;
    gate.track({ x: 200, y: 300, t });
    gate.arm(t);

    expect(gate.poll(t + HOVER_INTENT_WARM_DWELL_MS + 5)).toBe(false);
  });

  it("keeps a keyboard or click trigger instant", () => {
    const gate = new HoverIntentGate();
    const t = 1000;
    gate.track({ x: 200, y: 300, t });
    gate.openNow(t);

    // An immediate open leaves the gate warm, so the pointer can continue
    // through neighbouring rows without waiting out the full dwell again.
    gate.disarm(t + 10);
    gate.arm(t + 20);
    expect(gate.poll(t + 20 + HOVER_INTENT_WARM_DWELL_MS + 5)).toBe(true);
  });
});

describe("hoverIntentHandlers", () => {
  // A stand-in gate that never decides on its own: the deferred open is kept
  // so a test can run it at the moment a real gate would have.
  const setup = () => {
    const calls: string[] = [];
    const target = { id: "trigger" } as unknown as HTMLElement;
    let pendingOpen: (() => void) | undefined;
    const handlers = hoverIntentHandlers({
      intent: {
        arm: (open) => {
          calls.push("arm");
          pendingOpen = open;
        },
        immediate: (open) => {
          calls.push("immediate");
          open();
        },
        cancel: () => calls.push("cancel"),
        cardClosed: () => calls.push("cardClosed")
      },
      show: () => calls.push("show"),
      hide: () => calls.push("hide")
    });
    return {
      calls,
      handlers,
      target,
      runPendingOpen: (): void => pendingOpen?.()
    };
  };

  it("defers a hover instead of showing straight away", () => {
    const { calls, handlers, target, runPendingOpen } = setup();
    handlers.onMouseEnter(target);
    expect(calls).toEqual(["arm"]);

    // The armed callback is the show, it just has not been allowed to run.
    runPendingOpen();
    expect(calls).toEqual(["arm", "show"]);
  });

  it("shows immediately on focus", () => {
    const { calls, handlers, target } = setup();
    handlers.onFocus(target);
    expect(calls).toEqual(["immediate", "show"]);
  });

  it("shows immediately for a click that reveals the popup", () => {
    const { calls, handlers, target } = setup();
    handlers.showNow(target);
    expect(calls).toEqual(["immediate", "show"]);
  });

  it("cancels a pending open and hides on leave and on blur", () => {
    const { calls, handlers, target } = setup();
    handlers.onMouseEnter(target);
    calls.length = 0;
    handlers.onMouseLeave();
    expect(calls).toEqual(["cancel", "hide"]);

    calls.length = 0;
    handlers.onBlur();
    expect(calls).toEqual(["cancel", "hide"]);
  });

  it("takes the tooltip with it when a click does something else", () => {
    const { calls, handlers } = setup();
    handlers.leave();
    expect(calls).toEqual(["cancel", "hide"]);
  });
});
