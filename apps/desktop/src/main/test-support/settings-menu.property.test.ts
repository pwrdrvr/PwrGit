import Database from "better-sqlite3";
import fc from "fast-check";
import { expect, test } from "vitest";
import { clickSettingsMenu } from "../../../e2e/fixtures/settings-menu";

test("the Settings menu can open when evaluation interrupts an active SQLite query", async () => {
  await fc.assert(fc.asyncProperty(fc.integer(), async (value) => {
    const db = new Database(":memory:");
    try {
      let clicked: Promise<void> | undefined;
      let clickCount = 0;
      const Menu = {
        getApplicationMenu: () => ({ items: [{ submenu: { items: [{
          label: "Settings…",
          click: () => {
            clickCount += 1;
            expect(db.prepare("SELECT ? AS value").get(value)).toEqual({ value });
          }
        }] } }] })
      } as unknown as typeof import("electron").Menu;
      db.function("interrupt", () => {
        clicked = Promise.resolve(clickSettingsMenu({ Menu }));
        return 1;
      });
      db.prepare("SELECT interrupt()").get();
      expect(clicked).toBeDefined();
      await clicked;
      expect(clickCount).toBe(1);
    } finally {
      db.close();
    }
  }), { numRuns: 20 });
});
