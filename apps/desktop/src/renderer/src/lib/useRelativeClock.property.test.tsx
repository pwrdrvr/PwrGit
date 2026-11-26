// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRelativeClock } from "./useRelativeClock";

const MINUTE_MS = 60_000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useRelativeClock property invariants", () => {
  it("notifies on focus/visibility only when the minute bucket advances", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
        fc.array(
          fc.record({
            deltaMs: fc.integer({ min: 0, max: 120_000 }),
            kind: fc.constantFrom("focus" as const, "visibility" as const)
          }),
          { minLength: 1, maxLength: 16 }
        ),
        (startMs, events) => {
          // Align near the start of a minute so small deltas stay inside the same bucket.
          const baseMs = Math.floor(startMs / MINUTE_MS) * MINUTE_MS + 100;
          vi.setSystemTime(baseMs);

          let renders = 0;
          let latestNow = 0;
          function Probe() {
            renders += 1;
            latestNow = useRelativeClock();
            return <span>{latestNow}</span>;
          }

          act(() => root.render(<Probe />));
          const initialRenders = renders;
          let lastBucket = Math.floor(latestNow / MINUTE_MS);
          let expectedNotifications = 0;
          let currentMs = baseMs;

          for (const event of events) {
            currentMs += event.deltaMs;
            // Advance clock without firing the minute timer to simulate
            // background throttling before a focus/visibility wakeup.
            vi.setSystemTime(currentMs);
            const bucket = Math.floor(currentMs / MINUTE_MS);

            act(() => {
              if (event.kind === "focus") {
                window.dispatchEvent(new Event("focus"));
              } else {
                Object.defineProperty(document, "visibilityState", {
                  configurable: true,
                  value: "visible"
                });
                document.dispatchEvent(new Event("visibilitychange"));
              }
            });

            if (bucket !== lastBucket) {
              expectedNotifications += 1;
              lastBucket = bucket;
            }
            expect(Math.floor(latestNow / MINUTE_MS)).toBe(lastBucket);
            expect(renders - initialRenders).toBe(expectedNotifications);
          }

          act(() => root.unmount());
          root = createRoot(container);
        }
      ),
      { numRuns: 30, seed: 2026112601 }
    );
  });
});
