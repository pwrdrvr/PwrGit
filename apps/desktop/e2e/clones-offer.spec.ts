import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = { ready: Promise<void>; calls: string[]; mount: (view: string) => void };
const mount = (page: Page, view: string): Promise<void> =>
  page.evaluate((name) => (window as unknown as { __harness: Harness }).__harness.mount(name), view);
const calls = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { __harness: Harness }).__harness.calls]);

/**
 * Clones in Repository maintenance › Combined, and the one-time offer, in a
 * Vite build of the real dialog, toast host and offer hook against a fake
 * bridge (`harness/clones-offer`).
 * Design: "Clones in Maintenance - UX Review", turns 1–3.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("Clones in Combined, and the offer that runs it alone", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-clones-offer-"));
  const html = await buildHarness("clones-offer", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1100", PWRGIT_HARNESS_HEIGHT: "1000" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const shoot = async (name: string, selector: string): Promise<void> => {
      if (!shots) return;
      await page.mouse.move(0, 0);
      await page.locator(selector).first().screenshot({ path: join(shots, `${name}.png`) });
    };
    const dialog = page.getByRole("dialog", { name: "Repository maintenance" });

    // Combined: Clones is step 4, checked, between branches and GC.
    await mount(page, "plan");
    const clones = dialog.getByRole("checkbox", { name: "Share unchanged files with clones" });
    await expect(clones).toBeChecked();
    await expect(clones).toBeEnabled();
    await expect(dialog.locator(".maintenance__plan-step h3")).toHaveText([
      "Repair broken worktree links", "Remove finished worktrees", "Delete finished local branches",
      "Share unchanged files with clones", "Collect garbage"
    ]);
    await expect(dialog.getByRole("button", { name: "Start" })).toBeEnabled();
    await shoot("combined-plan", ".modal");

    // A Git that cannot re-share: unchecked, disabled, and says why.
    await mount(page, "plan-homebrew");
    await expect(clones).not.toBeChecked();
    await expect(clones).toBeDisabled();
    await expect(dialog).toContainText("Needs PwrGit’s Git");
    await dialog.locator(".maintenance__plan-step").nth(3).scrollIntoViewIfNeeded();
    await shoot("combined-plan-no-reshare", ".modal");

    // The offer: three wordings, one action.
    for (const kind of ["files", "partial", "measured"]) {
      await mount(page, `offer-${kind}`);
      await expect(page.locator(".app-toast")).toContainText("Save disk space");
      await shoot(`offer-${kind}`, ".app-toast");
    }
    await expect(page.locator(".app-toast")).toContainText("about 6.32 GiB (projected)");
    await page.getByRole("button", { name: "Share files" }).click();
    // Accepting runs Combined with exactly one step: Clones.
    await expect(dialog.locator(".maintenance__done-status")).toContainText("Maintenance finished");
    expect(await calls(page)).toEqual(["answer:accepted", "reshare"]);
    await expect(dialog.locator(".maintenance__receipt-step strong")).toHaveText([
      "Worktrees", "Local branches", "Clones", "Garbage collection"
    ]);
    await expect(dialog.locator(".maintenance__receipt-step.is-skipped")).toHaveCount(3);
    await expect(dialog).toContainText("6.18 GiB now shared · 41 worktrees");
    await expect(page.locator(".app-toast")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Show" }).first().click();
    await shoot("clones-only-receipt", ".modal");
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
