import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * U1 verification: the app boots a single window with the React root mounted.
 * (The single-instance lock itself is exercised at runtime via
 * app.requestSingleInstanceLock() in src/main/index.ts; launching a second
 * packaged instance is out of scope for this smoke spec.)
 */
test("boots a single window with #root mounted", async () => {
  const electronApp = await electron.launch({
    args: [join(__dirname, "..", "out", "main", "index.js")]
  });

  const window = await electronApp.firstWindow();
  await window.waitForSelector("#root");

  expect(await window.title()).toBe("PwrGit");
  expect(electronApp.windows().length).toBe(1);

  await electronApp.close();
});
