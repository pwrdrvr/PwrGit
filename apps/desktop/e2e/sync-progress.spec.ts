import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = { ready: Promise<void>; mount: (view: string, theme: string, width: number) => void };
const mount = (page: Page, view: string, theme: string, width: number): Promise<void> =>
  page.evaluate(
    ([name, mode, w]) => (window as unknown as { __harness: Harness }).__harness.mount(name as string, mode as string, w as number),
    [view, theme, width] as const
  );

/**
 * A live run on the sync button, in a Vite build of the real `SidebarToolbar`
 * (`harness/sync-progress`): "Pulling 12/27" on the face with its outcome
 * bar, the count kept at the icon-only step, the live hover card, and the
 * running sync's hint in Sync options.
 * design/Sync Progress on the Button - UX Review.dc.html, 2a and 3a.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("a live run's progress on the sync button", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-sync-progress-"));
  const html = await buildHarness("sync-progress", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "480", PWRGIT_HARNESS_HEIGHT: "1000" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const face = page.getByRole("button", { name: "Try pull recent" });
    const shoot = async (name: string, below: string): Promise<void> => {
      if (!shots) return;
      const box = (await page.locator(below).last().boundingBox())!;
      await page.screenshot({
        path: join(shots, `${name}.png`),
        clip: {
          x: 0,
          y: 0,
          width: Math.ceil(Math.max(340, box.x + box.width + 12)),
          height: Math.ceil(Math.max(box.y + box.height + 12, 60))
        }
      });
    };
    const hoverCard = async (): Promise<void> => {
      // The remounted face sits under the pointer already; leave and come back.
      await page.mouse.move(0, 400);
      await face.hover();
      await expect(page.locator(".viewport-tooltip")).toBeVisible();
    };

    for (const theme of ["dark", "light"]) {
      await mount(page, "before", theme, 320);
      await hoverCard();
      await expect(page.locator(".viewport-tooltip")).toContainText("Running now");
      await shoot(`before-${theme}`, ".viewport-tooltip");

      await mount(page, "after", theme, 320);
      await expect(face).toHaveText("Pulling12/27");
      await expect(face).toHaveAttribute("aria-description", "12 of 27 repositories finished, 1 failed");
      await hoverCard();
      const card = page.locator(".sync-run-card");
      await expect(card).toContainText("Pulling the Focused list");
      await expect(card).toContainText("12 of 27");
      await expect(card).toContainText("Click to open");
      await shoot(`after-hover-${theme}`, ".viewport-tooltip");

      await page.mouse.move(0, 400);
      await page.getByRole("button", { name: "Sync options" }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await expect(page.getByRole("menuitem", { name: /Show the running sync/ })).toContainText(/12 of 27 · 1 failed · automatic, \d/);
      await shoot(`after-menu-${theme}`, '[role="menu"]');
      await page.keyboard.press("Escape");

      // The icon-only step keeps the count, whole and inside the button.
      await mount(page, "after", theme, 180);
      await expect(page.locator(".sidebar-toolbar--icons")).toHaveCount(1);
      const fits = await page.locator(".sidebar-toolbar__count").evaluate((count) => {
        const box = count.getBoundingClientRect();
        const split = count.closest(".sidebar-toolbar__split")!.getBoundingClientRect();
        return box.width > 0 && box.left >= split.left && box.right <= split.right - 20;
      });
      expect(fits).toBe(true);
      await shoot(`after-narrow-${theme}`, ".sidebar-toolbar");
    }
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
