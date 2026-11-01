import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

test("branch errors stay visible above successful deletions and do not prevent collection", async () => {
  const out = mkdtempSync(join(tmpdir(), "pwrgit-maintenance-results-"));
  const html = await buildHarness("maintenance", join(out, "dist"));
  const app = await electron.launch({
    args: ["--disable-accelerated-video-decode", "--disable-accelerated-video-encode", join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1100", PWRGIT_HARNESS_HEIGHT: "900" })
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
    await page.getByLabel("Remove finished worktrees", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".maintenance__done-status")).toBeVisible();
    const shots = process.env["PWRGIT_HARNESS_SHOTS"];
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, "maintenance-results.png") });
    }
    await expect(page.locator(".maintenance__done-status")).toContainText("Maintenance finished with errors");
    const issues = page.getByRole("region", { name: "Needs attention" });
    await expect(issues).toContainText("finished/task-27");
    await expect(issues).toContainText("The branch changed or is no longer eligible");
    const issueBox = await issues.boundingBox();
    const statusBox = await page.locator(".maintenance__done-status").boundingBox();
    expect(issueBox!.y).toBeGreaterThan(statusBox!.y);
    expect(issueBox!.y + issueBox!.height).toBeLessThan(900);
    await expect(page.locator(".maintenance__receipt-step").last()).toContainText("1 collected");
    expect(await page.evaluate(() => (window as unknown as { __harness: { calls: string[] } }).__harness.calls)).toEqual(["scan-branches", "delete-branches", "gc"]);
    // A whole failed batch must remain readable without filling the dialog.
    await page.evaluate(() => (window as unknown as { __harness: { retainAll: () => void } }).__harness.retainAll());
    await page.getByRole("button", { name: "New plan", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".maintenance__done-status")).toBeVisible();
    const scroll = page.locator(".maintenance__issue-list");
    expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(issues).toContainText("finished/task-27");
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
