import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * U1 verification: the app boots a single window with the React root mounted.
 * (The single-instance lock itself is exercised at runtime via
 * app.requestSingleInstanceLock() in src/main/index.ts; launching a second
 * packaged instance is out of scope for this smoke spec.)
 */
test("boots a single window with #root mounted", async () => {
  const electronApp = await electron.launch({
    args: [join(HERE, "..", "out", "main", "index.js")]
  });

  const window = await electronApp.firstWindow();
  await window.waitForSelector("#root");

  // One window per profile: the title carries the booted profile's name.
  expect(await window.title()).toMatch(/^PwrGit( — .+)?$/);
  expect(electronApp.windows().length).toBe(1);

  await electronApp.close();
});
