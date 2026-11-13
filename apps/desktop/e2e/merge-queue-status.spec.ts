import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = { ready: Promise<void>; mount: (theme: "dark" | "light") => void };
const mount = (page: Page, theme: "dark" | "light"): Promise<void> =>
  page.evaluate((name) => (window as unknown as { __harness: Harness }).__harness.mount(name), theme);

/**
 * Merge-queue states on the PR chip and its card, in a Vite build of the
 * real `PrChip` and `PrStatusCard` against contrived PRs
 * (`harness/merge-queue`). Hidden window; no forge is asked.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each theme's grid as a PNG.
 */
test("merge-queue states read as the queue's, not as green or merged", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-merge-queue-"));
  const html = await buildHarness("merge-queue", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1500", PWRGIT_HARNESS_HEIGHT: "520" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    for (const theme of ["dark", "light"] as const) {
      await mount(page, theme);
      // Shot first, so a run against older code still records its "before".
      await expect(page.locator(".mq-harness section")).toHaveCount(5);
      if (shots) await page.locator(".mq-harness").screenshot({ path: join(shots, `merge-queue-${theme}.png`) });
      const row = (label: string) => page.locator(`[data-row="${label}"]`);
      await expect(row("Ready to queue").getByRole("button", { name: "Add to merge queue" })).toBeVisible();
      await expect(row("Queued, #3")).toContainText("queued #3");
      await expect(row("Queued, #3").locator(".pr-chip")).toHaveClass(/pr-chip--queued/);
      await expect(row("Merge group checks running")).toContainText("merge group checks running");
      await expect(row("Removed from queue")).toContainText("merge group checks failed");
      await expect(row("Merged by queue")).toContainText("merged by queue");
    }
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
