import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

/**
 * Repository maintenance keeps one frame from open to close, and every
 * footer ends with its primary action. Walks every screen the dialog can
 * reach against a fake bridge (`harness/maintenance`) and checks, on each:
 *
 * - the dialog's box is the first screen's box, to the pixel, and the
 *   footer lies inside it;
 * - no secondary button follows a primary (`modal__create`) one, and the
 *   last button is a primary;
 * - on a screen that ends the job, that last button is Close.
 *
 * Design: "Maintenance Steady Height - UX Review", turns 1 and 2.
 * `PWRGIT_HARNESS_SHOTS=<dir>` writes each screen as a PNG.
 */
type Box = { x: number; y: number; width: number; height: number };

for (const [width, height] of [[1100, 900], [1000, 650]]) {
  test(`maintenance keeps one frame and ends each footer with its primary at ${width}x${height}`, async () => {
    test.setTimeout(120_000);
    const out = mkdtempSync(join(tmpdir(), "pwrgit-maintenance-steady-"));
    const html = await buildHarness("maintenance", join(out, "dist"));
    const app = await electron.launch({
      args: [
        "--disable-accelerated-video-decode",
        "--disable-accelerated-video-encode",
        ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
        join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
      ],
      env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: String(width), PWRGIT_HARNESS_HEIGHT: String(height) })
    });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => "__harness" in window);
      await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
      const dialog = page.getByRole("dialog", { name: "Repository maintenance" });
      const tab = (name: string) => dialog.getByRole("group", { name: "Maintenance task" }).getByRole("button", { name, exact: true });
      const button = (name: string) => dialog.getByRole("button", { name, exact: true });
      await expect(button("Start")).toBeEnabled();

      let frame: Box | undefined;
      const seen: string[] = [];
      const check = async (screen: string, end: boolean) => {
        await settle(page);
        const box = (await dialog.boundingBox())!;
        frame ??= box;
        expect.soft(box, `${screen}: dialog box`).toEqual(frame);
        // The footer sits whole inside the frame: content scrolls, never pushes it out.
        const actions = (await dialog.locator(".modal__actions:visible").last().boundingBox())!;
        expect.soft(actions.y + actions.height, `${screen}: footer inside the dialog`).toBeLessThanOrEqual(box.y + box.height);
        const footer = await footerButtons(dialog);
        expect.soft(footer.length, `${screen}: footer has buttons`).toBeGreaterThan(0);
        const firstPrimary = footer.findIndex((item) => item.primary);
        expect.soft(footer.slice(firstPrimary < 0 ? footer.length : firstPrimary).every((item) => item.primary),
          `${screen}: no secondary after a primary in ${JSON.stringify(footer)}`).toBe(true);
        expect.soft(footer.at(-1)?.primary, `${screen}: last button is primary in ${JSON.stringify(footer)}`).toBe(true);
        if (end) expect.soft(footer.at(-1)?.name, `${screen}: an end screen closes last`).toBe("Close");
        seen.push(screen);
        await shot(page, `maintenance-steady-${width}-${seen.length}-${screen}`);
      };

      await check("combined-plan", false);
      await tab("Repair links").click();
      await check("repair-setup", false);
      await button("Repair worktree links").click();
      await expect(dialog.locator(".bulk-sync__status")).toBeVisible();
      await check("repair-finished", true);
      await tab("Worktrees").click();
      await expect(button("Find finished worktrees")).toBeVisible();
      await check("worktrees-setup", false);
      await tab("Clones").click();
      await check("clones-setup", false);
      await tab("Local branches").click();
      await check("branches-setup", false);
      await button("Review local branches").click();
      await expect(dialog.getByText("27 of 27 selected")).toBeVisible();
      await check("branches-review", false);
      await dialog.getByRole("button", { name: /^Delete 27 selected/ }).click();
      await expect(dialog.locator(".bulk-sync__status")).toContainText("Finished");
      await check("branches-finished", true);
      await tab("Garbage collection").click();
      await check("gc-setup", false);
      await button("Run garbage collection").click();
      await expect(dialog.locator(".bulk-sync__status")).toContainText("Finished");
      await check("gc-finished", true);
      await tab("Combined").click();
      await check("combined-plan-again", false);
      await dialog.getByLabel("Remove finished worktrees", { exact: true }).uncheck();
      await button("Start").click();
      await expect(dialog.locator(".maintenance__done-status")).toBeVisible();
      await check("combined-results", true);
      expect(seen).toHaveLength(12);
    } finally {
      await app.close();
      rmSync(out, { recursive: true, force: true });
    }
  });
}

/** The footer's visible buttons, left to right, and whether each is a primary. */
async function footerButtons(dialog: Locator): Promise<{ name: string; primary: boolean }[]> {
  return dialog.evaluate((node) => {
    const footers = [...node.querySelectorAll<HTMLElement>(".modal__actions")].filter((el) => el.offsetParent !== null);
    const footer = footers.at(-1);
    if (!footer) return [];
    return [...footer.querySelectorAll<HTMLButtonElement>("button")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ name: el.textContent?.trim() ?? "", primary: el.classList.contains("modal__create") }));
  });
}

/** After the opening animation and two frames past the last change, so a
 *  measurement never reads a mid-animation or mid-swap layout. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["PWRGIT_HARNESS_SHOTS"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" });
}
