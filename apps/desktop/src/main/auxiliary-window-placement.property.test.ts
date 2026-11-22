import fc from "fast-check";
import type { Rectangle } from "electron";
import { expect, test } from "vitest";
import {
  auxiliaryWindowBounds,
  createAuxiliaryWindowPlacer,
  type PlaceableWindow,
  type PlacementScreen
} from "./auxiliary-window-placement";

type Display = { id: number; workArea: Rectangle };

const overlap = (a: Rectangle, b: Rectangle): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const distance = (r: Rectangle, p: { x: number; y: number }): number =>
  Math.hypot(
    Math.max(r.x - p.x, 0, p.x - (r.x + r.width)),
    Math.max(r.y - p.y, 0, p.y - (r.y + r.height))
  );

/** Electron's rules: most overlap wins; no overlap means the nearest. */
function fakeScreen(displays: Display[], cursor: { x: number; y: number }): PlacementScreen {
  const nearest = (p: { x: number; y: number }): Display =>
    displays.reduce((best, d) => (distance(d.workArea, p) < distance(best.workArea, p) ? d : best));
  return {
    getDisplayMatching: (rect) => {
      const best = displays.reduce((b, d) =>
        overlap(d.workArea, rect) > overlap(b.workArea, rect) ? d : b
      );
      return overlap(best.workArea, rect) > 0
        ? best
        : nearest({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    },
    getDisplayNearestPoint: nearest,
    getCursorScreenPoint: () => cursor
  };
}

function fakeWindow(bounds: Rectangle): PlaceableWindow & { bounds: Rectangle } {
  const w = {
    bounds,
    getBounds: () => ({ ...w.bounds }),
    setBounds: (next: Rectangle) => {
      w.bounds = { ...next };
    },
    isMinimized: () => false,
    isDestroyed: () => false
  };
  return w;
}

// Monitors laid side by side (and sometimes stacked), each with a menu-bar
// inset, at mixed sizes — the setup where the primary display is not the one
// the user is looking at.
const displaysArb = fc
  .array(
    fc.record({
      width: fc.integer({ min: 800, max: 3840 }),
      height: fc.integer({ min: 600, max: 2160 }),
      dy: fc.integer({ min: -1200, max: 1200 }),
      inset: fc.integer({ min: 0, max: 40 })
    }),
    { minLength: 1, maxLength: 4 }
  )
  .map((specs) => {
    let x = 0;
    return specs.map((s, id): Display => {
      const workArea = { x, y: s.dy + s.inset, width: s.width, height: s.height - s.inset };
      x += s.width;
      return { id, workArea };
    });
  });

const within = (inner: Rectangle, outer: Rectangle): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** A profile window somewhere on display `d`, possibly hanging off its edge. */
const openerOn = (d: Display, fx: number, fy: number, w: number, h: number): Rectangle => ({
  x: Math.round(d.workArea.x + fx * d.workArea.width - w / 2),
  y: Math.round(d.workArea.y + fy * d.workArea.height - h / 2),
  width: w,
  height: h
});

const frac = fc.double({ min: 0, max: 1, noNaN: true });

test("an auxiliary window lands inside the work area, centered on the opener when it fits", () => {
  fc.assert(
    fc.property(
      displaysArb,
      fc.nat(),
      frac,
      frac,
      fc.integer({ min: 400, max: 3000 }),
      fc.integer({ min: 300, max: 2000 }),
      fc.integer({ min: 400, max: 1400 }),
      fc.integer({ min: 300, max: 1000 }),
      (displays, pick, fx, fy, ow, oh, width, height) => {
        const display = displays[pick % displays.length]!;
        const opener = openerOn(display, fx, fy, ow, oh);
        const placed = auxiliaryWindowBounds({ width, height }, display.workArea, opener);
        expect(within(placed, display.workArea)).toBe(true);
        expect(placed.width).toBe(Math.min(width, display.workArea.width));
        expect(placed.height).toBe(Math.min(height, display.workArea.height));
        const centered = {
          x: Math.round(opener.x + opener.width / 2 - placed.width / 2),
          y: Math.round(opener.y + opener.height / 2 - placed.height / 2),
          width: placed.width,
          height: placed.height
        };
        if (within(centered, display.workArea)) expect(placed).toEqual(centered);
      }
    )
  );
});

// Model: every summon names an opener (a profile window on some display) or
// nothing. After it, the auxiliary window is on the opener's display (the
// cursor's when there is none); and a window already on that display has not
// moved, so a spot the user chose survives being summoned again.
test("a summoned auxiliary window is on the opener's display, and only moves to get there", () => {
  fc.assert(
    fc.property(
      displaysArb,
      fc.array(
        fc.record({
          opener: fc.option(
            fc.record({ pick: fc.nat(), fx: frac, fy: frac }),
            { nil: null }
          ),
          cursor: fc.record({ pick: fc.nat(), fx: frac, fy: frac })
        }),
        { minLength: 1, maxLength: 8 }
      ),
      (displays, summons) => {
        // Electron's own default: centered on the primary display.
        const primary = displays[0]!.workArea;
        const aux = fakeWindow(
          auxiliaryWindowBounds({ width: 980, height: 720 }, primary, null)
        );
        // One placer for the whole run; each step swaps in its cursor.
        let screen = fakeScreen(displays, { x: 0, y: 0 });
        const place = createAuxiliaryWindowPlacer({
          getDisplayMatching: (rect) => screen.getDisplayMatching(rect),
          getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
          getCursorScreenPoint: () => screen.getCursorScreenPoint()
        });
        let first = true;
        for (const summon of summons) {
          const c = displays[summon.cursor.pick % displays.length]!.workArea;
          const cursor = {
            x: Math.round(c.x + summon.cursor.fx * (c.width - 1)),
            y: Math.round(c.y + summon.cursor.fy * (c.height - 1))
          };
          screen = fakeScreen(displays, cursor);
          const opener =
            summon.opener === null
              ? null
              : fakeWindow(
                  openerOn(
                    displays[summon.opener.pick % displays.length]!,
                    summon.opener.fx,
                    summon.opener.fy,
                    1200,
                    800
                  )
                );
          const target =
            opener === null
              ? screen.getDisplayNearestPoint(cursor)
              : screen.getDisplayMatching(opener.getBounds());
          const before = aux.getBounds();
          const wasOnTarget = screen.getDisplayMatching(before).id === target.id;
          place(aux, opener);
          const after = aux.getBounds();
          if (opener === null && !first) {
            expect(after).toEqual(before);
          } else {
            expect(screen.getDisplayMatching(after).id).toBe(target.id);
            expect(within(after, target.workArea)).toBe(true);
            if (!first && wasOnTarget) expect(after).toEqual(before);
          }
          first = false;
        }
      }
    )
  );
});

