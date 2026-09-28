import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow, repoGroup } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

async function triggerActiveRefresh(app: AppHandle): Promise<void> {
  await app.app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      // The same focus hook the 15s poll shares; no private test channel.
      electronApp.emit("browser-window-focus", {}, win);
    }
  });
}

// The profile rescan is throttled to once a day and nothing watches the scan
// roots, so a deleted repository used to stay in the sidebar, flagged
// missing, with every command failing until the next day's scan.
test("drops a repository from the sidebar when its folder is deleted", async () => {
  sandbox = createGitSandbox();
  const doomed = sandbox.makeRepo("doomed");
  sandbox.makeRepo("survivor");
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "doomed");
  const row = branchRow(window, "main");
  await row.click();
  await expect(row).toHaveClass(/is-selected/);
  await expect(window.locator(".wt-header")).toBeVisible();

  rmSync(doomed.path, { recursive: true, force: true });
  await triggerActiveRefresh(handle);

  await expect(repoGroup(window, "doomed")).toHaveCount(0);
  // The rescan may prune only while some repository still resolves.
  await expect(repoGroup(window, "survivor")).toBeVisible();
  // The viewed checkout went with it, and the main pane lets go of it.
  await expect(window.locator(".wt-header")).toHaveCount(0);
});
