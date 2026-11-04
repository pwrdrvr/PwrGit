import fc from "fast-check";
import { expect, it } from "vitest";
import { mapLimit } from "./git-metadata.js";

// Before #317 a failed read returned while sibling reads still ran Git in a
// checkout the caller might remove next (Windows refuses that removal).
it("mapLimit rejects iff a read rejects, bounds reads in flight, and settles only when none still run", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(fc.boolean().map((fails) => ({ fails })), { maxLength: 12 }),
      fc.integer({ min: 1, max: 5 }),
      async (s, items, max) => {
        let inFlight = 0;
        let peak = 0;
        const ran: number[] = [];
        const rejected = new Set<Error>();
        const run = mapLimit(items, max, async (item, index) => {
          ran.push(index);
          peak = Math.max(peak, ++inFlight);
          try {
            await s.schedule(Promise.resolve(), `read ${index}`);
            if (item.fails) {
              const failure = new Error(`read ${index} failed`);
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
        expect(outcome.running).toBe(0);
        if (outcome.ok) {
          expect(rejected.size).toBe(0);
          expect([...ran].sort((a, b) => a - b)).toEqual(items.map((_, i) => i));
          expect(outcome.value).toEqual(items.map((_, i) => i));
        } else {
          expect(rejected.has(outcome.error as Error)).toBe(true);
        }
      }
    )
  );
});
