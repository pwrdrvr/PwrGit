import { describe, expect, it } from "vitest";
import {
  HOVER_INTENT_DWELL_MS,
  HOVER_INTENT_WARM_DWELL_MS,
  HoverIntentGate,
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
