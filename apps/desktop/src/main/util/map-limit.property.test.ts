import fc from "fast-check";
import { expect, it } from "vitest";
import { limitConcurrency, mapLimit } from "./map-limit";

// Each call succeeds or fails; the scheduler picks when each one finishes.
const calls = fc.array(fc.boolean().map((fails) => ({ fails })), { maxLength: 12 });
const limit = fc.integer({ min: 1, max: 5 });

it("mapLimit rejects iff a call rejects, bounds calls in flight, and settles only when none still run", async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), calls, limit, async (s, items, max) => {
      let inFlight = 0;
      let peak = 0;
      const ran: number[] = [];
      const rejected = new Set<Error>();
      const run = mapLimit(items, max, async (item, index) => {
        ran.push(index);
        peak = Math.max(peak, ++inFlight);
        try {
          await s.schedule(Promise.resolve(), `call ${index}`);
          if (item.fails) {
            const failure = new Error(`call ${index} failed`);
            rejected.add(failure);
            throw failure;
          }
          return index;
        } finally {
          inFlight -= 1;
        }
      });
      const outcome = await s.waitFor(run.then(
        (value) => ({ ok: true as const, value, running: inFlight }),
        (error: unknown) => ({ ok: false as const, error, running: inFlight })
      ));

      expect(peak).toBeLessThanOrEqual(max);
      // A caller that holds a lock around mapLimit must not release it while
      // a call still runs Git in the checkout it is about to touch.
      expect(outcome.running).toBe(0);
      if (outcome.ok) {
        expect(rejected.size).toBe(0);
        expect([...ran].sort((a, b) => a - b)).toEqual(items.map((_, i) => i));
        expect(outcome.value).toEqual(items.map((_, i) => i));
      } else {
        expect(rejected.has(outcome.error as Error)).toBe(true);
      }
    })
  );
});

it("limitConcurrency settles each call with its own outcome and never exceeds the shared ceiling", async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), calls, limit, async (s, items, max) => {
      let inFlight = 0;
      let peak = 0;
      const ran: number[] = [];
      const limited = limitConcurrency(async (index: number) => {
        ran.push(index);
        peak = Math.max(peak, ++inFlight);
        try {
          await s.schedule(Promise.resolve(), `call ${index}`);
          if (items[index]!.fails) throw new Error(`call ${index} failed`);
          return index;
        } finally {
          inFlight -= 1;
        }
      }, max);
      // Overlapping callers arrive in the scheduler's order, not all at once.
      const results = items.map((_, index) =>
        s.schedule(Promise.resolve(), `arrive ${index}`).then(() => limited(index))
      );
      const settled = await s.waitFor(Promise.allSettled(results));

      expect(peak).toBeLessThanOrEqual(max);
      expect(inFlight).toBe(0);
      expect([...ran].sort((a, b) => a - b)).toEqual(items.map((_, i) => i));
      settled.forEach((result, index) => {
        if (items[index]!.fails) {
          expect(result).toEqual({ status: "rejected", reason: new Error(`call ${index} failed`) });
        } else {
          expect(result).toEqual({ status: "fulfilled", value: index });
        }
      });
    })
  );
});
