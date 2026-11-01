import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

/**
 * Combined maintenance's outcome cards, measured in a Vite build of the real
 * dialog against a fake bridge (`harness/maintenance`): a retained branch
 * after a full receipt page, then a whole batch retained. Design:
 * "Maintenance Continues Past Errors - UX Review", 2a and 2b.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes both results as PNGs there
 * (`maintenance-results.png`, `maintenance-results-all-retained.png`).
 */
test("branch errors stay visible above successful deletions and do not prevent collection", async () => {
  // The harness build runs inside the test, so it gets the sibling specs' budget.
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-maintenance-results-"));
  const html = await buildHarness("maintenance", join(out, "dist"));
  const app = await electron.launch({
    args: [
      // As `launchApp` does: hardware codecs leak VideoToolbox clients in the
      // Tart guests even with the GPU off (e2e/AGENTS.md).
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1100", PWRGIT_HARNESS_HEIGHT: "900" })
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
    await page.getByLabel("Remove finished worktrees", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const status = page.locator(".maintenance__done-status");
    await expect(status).toBeVisible();
    const shots = process.env["PWRGIT_HARNESS_SHOTS"];
    if (shots) {
      mkdirSync(shots, { recursive: true });
      // Park the pointer off the dialog: the Start click leaves it on a Restore link.
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(shots, "maintenance-results.png") });
    }
    await expect(status).toContainText("Maintenance finished with errors");
    const issues = page.getByRole("alert", { name: "1 branch wasn’t deleted" });
    await expect(issues).toContainText("finished/task-27");
    await expect(issues).toContainText("The branch changed or is no longer eligible");
    // Under the status card, wholly above the receipt, and on screen.
    const issueBox = (await issues.boundingBox())!;
    const statusBox = (await status.boundingBox())!;
    const receiptBox = (await page.locator(".maintenance__receipt-steps").boundingBox())!;
    expect(issueBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height);
    expect(issueBox.y + issueBox.height).toBeLessThanOrEqual(receiptBox.y);
    expect(issueBox.y + issueBox.height).toBeLessThan(900);
    await expect(page.locator(".maintenance__receipt-step").nth(1)).toContainText("26 deleted in 1 repository · 1 not deleted");
    await expect(page.locator(".maintenance__receipt-step").last()).toContainText("1 collected");
    expect(await page.evaluate(() => (window as unknown as { __harness: { calls: string[] } }).__harness.calls)).toEqual(["scan-branches", "delete-branches", "gc"]);
    // A whole failed batch must remain readable without filling the dialog.
    await page.evaluate(() => (window as unknown as { __harness: { retainAll: () => void } }).__harness.retainAll());
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(status).toBeVisible();
    const all = page.getByRole("alert", { name: "27 branches weren’t deleted" });
    const scroll = all.getByRole("list", { name: "Branches not deleted" });
    await expect(scroll).toBeVisible();
    if (shots) {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(shots, "maintenance-results-all-retained.png") });
    }
    expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(scroll).toContainText("finished/task-27");
    // The head never scrolls away with its rows.
    await expect(all.locator(".maintenance__problem-head")).toBeInViewport();
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
