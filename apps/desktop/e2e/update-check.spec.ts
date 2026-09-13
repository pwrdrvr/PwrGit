// Help → Check for Updates, end to end.
//
// The app under test is unpackaged, so the check runs the dev/QA fake
// (`simulateDevUpdateCheck`) rather than reaching GitHub — which is the point:
// the fake walks the same status machine a real check does, so the toast is
// driven here exactly as it would be by a real download.

import { expect, test, type ElectronApplication } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

const FAKE_VERSION = "420.0.0";
/** Slow enough that the mid-download card is a target, not a race. Seven
 *  percent ticks at this pace give roughly six seconds to act. */
const UPDATE_STEP_MS = 800;

let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
});

async function checkForUpdates(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find(
        (candidate) => candidate.label === "Check for Updates"
      );
      if (item !== undefined) {
        item.click();
        return;
      }
    }
    throw new Error("Menu item not found: Check for Updates");
  });
}

test("a menu check reports itself live and ends on an actionable offer", async () => {
  handle = await launchApp({ updateStepMs: UPDATE_STEP_MS });
  const { app, window } = handle;

  // Nothing before the ask: startup and periodic checks stay silent.
  await expect(window.locator(".toast-host .app-toast")).toHaveCount(0);

  await checkForUpdates(app);

  const card = window.locator(".toast-host .app-toast").first();
  await expect(card).toContainText("Checking for updates");
  // The card reports work in flight, so it carries a progress track and NOT
  // the countdown bar that would dismiss it out from under a running check.
  await expect(card.locator(".app-toast__track")).toBeVisible();
  await expect(card.locator(".app-toast__timer")).toHaveCount(0);

  await expect(card).toContainText("Downloading update", { timeout: 15_000 });
  await expect(card).toContainText(`PwrGit v${FAKE_VERSION}`);
  await expect(card.locator(".app-toast__meter")).toContainText("MB of");
  await expect(
    card.locator("[role='progressbar']")
  ).toHaveAttribute("aria-valuenow", /\d+/);

  // And it ends on the one thing there is to do about it.
  await expect(window.locator(".toast-host")).toContainText(
    `Restart to update to v${FAKE_VERSION}.`,
    { timeout: 30_000 }
  );
  await expect(
    window.getByRole("button", { name: "Restart" })
  ).toBeVisible();
});

test("Cancel stops the download and says so without crying failure", async () => {
  handle = await launchApp({ updateStepMs: UPDATE_STEP_MS });
  const { app, window } = handle;

  await checkForUpdates(app);

  const card = window.locator(".toast-host .app-toast").first();
  await expect(card).toContainText("Downloading update", { timeout: 15_000 });

  await card.getByRole("button", { name: "Cancel" }).click();

  const toast = window.locator(".toast-host .app-toast").first();
  await expect(toast).toContainText("Download canceled", { timeout: 15_000 });
  await expect(toast).toContainText(`PwrGit v${FAKE_VERSION} is still available`);
  // A cancel is not a failure: info eyebrow, and no Logs button steering the
  // user toward output that records nothing wrong.
  await expect(toast.locator(".app-toast__eyebrow--info")).toBeVisible();
  await expect(toast.getByRole("button", { name: "Logs" })).toHaveCount(0);
  // Now it IS a finished notice, so it goes back on the countdown.
  await expect(toast.locator(".app-toast__timer")).toBeVisible();

  // Nothing was downloaded, so nothing is offered to restart into.
  await expect(
    window.getByRole("button", { name: "Restart" })
  ).toHaveCount(0);
});
