import fc from "fast-check";
import { expect, it } from "vitest";
import { triggerActiveRefresh } from "../e2e/fixtures/active-refresh";

it("defers focus listeners until a debugger-interrupted native query returns", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3 }), async (windowCount) => {
    const windows = Array.from({ length: windowCount }, () => ({}));
    const emitted = [];
    await triggerActiveRefresh({
      app: {
        evaluate(callback) {
          // CDP can enter JS while SQLite still owns its connection. Only a
          // fresh event-loop turn may invoke listeners that prepare queries.
          let queryBusy = true;
          setImmediate(() => { queryBusy = false; });
          return callback({
            BrowserWindow: { getAllWindows: () => windows },
            app: {
              emit(...args) {
                expect(queryBusy).toBe(false);
                emitted.push(args);
              }
            }
          });
        }
      }
    });
    expect(emitted).toEqual(windowCount === 0 ? [] : [["browser-window-focus", {}, windows[0]]]);
  }), { numRuns: 50 });
});
