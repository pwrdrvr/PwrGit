import { runInNewContext } from "node:vm";
import Database from "better-sqlite3";
import fc from "fast-check";
import { expect, it } from "vitest";
import { emitFocusOnMainLoop } from "../e2e/fixtures/focus-refresh";
import { getNativeBinding } from "../src/main/persistence/native-binding";

// Serialize exactly as Playwright does: no imported bindings survive in main.
function evaluateInMain(electron, queue) {
  return runInNewContext(`(${emitFocusOnMainLoop.toString()})(electron)`, {
    electron, setImmediate: (callback) => queue.push(callback)
  });
}

it("defers focus handling until the interrupted SQLite query has returned", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer(), { minLength: 1, maxLength: 4 }), async ids => {
    const nativeBinding = getNativeBinding();
    const db = new Database(":memory:", nativeBinding ? { nativeBinding } : {});
    try {
      const queue = [], events = [];
      let lookups = 0, pending;
      const electron = {
        BrowserWindow: { getAllWindows() { ++lookups; return ids.map(id => ({ id })); } },
        app: { emit(event, argument, win) {
          // The real SQLite connection is the oracle for reentry, not a timer
          // or a mocked "busy" flag. This prepare throws during interrupt().
          const row = db.prepare("SELECT ? AS id").get(win.id);
          events.push({ event, argument, id: row.id });
          return true;
        } }
      };
      db.function("interrupt", () => {
        // CDP evaluation can interrupt native SQLite just like this callback.
        pending = evaluateInMain(electron, queue);
        return 0;
      });
      db.prepare("SELECT interrupt()").get();
      expect(lookups).toBe(0);
      expect(events).toEqual([]);
      expect(queue).toHaveLength(1);
      queue.shift()();
      await pending;
      expect(lookups).toBe(1);
      expect(events).toEqual([{ event: "browser-window-focus", argument: {}, id: ids[0] }]);
      expect(queue).toEqual([]);
    } finally { db.close(); }
  }));
});

it("resolves without emitting if no window remains on the next turn", async () => {
  const queue = [];
  let emitted = false;
  const pending = evaluateInMain({
    BrowserWindow: { getAllWindows: () => [] },
    app: { emit() { emitted = true; } }
  }, queue);
  queue.shift()();
  await pending;
  expect(emitted).toBe(false);
});

it("rejects the evaluation when the deferred focus listener throws", async () => {
  const queue = [];
  const pending = evaluateInMain({
    BrowserWindow: { getAllWindows: () => [{}] },
    app: { emit() { throw new Error("focus listener failed"); } }
  }, queue);
  queue.shift()();
  await expect(pending).rejects.toThrow("focus listener failed");
});
