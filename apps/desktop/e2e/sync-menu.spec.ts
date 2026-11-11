import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = { ready: Promise<void>; calls: string[]; mount: (view: string, theme: string) => void };
const mount = (page: Page, view: string, theme: string): Promise<void> =>
  page.evaluate(([name, mode]) => (window as unknown as { __harness: Harness }).__harness.mount(name!, mode!), [view, theme]);
const calls = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { __harness: Harness }).__harness.calls]);

/**
 * The sync menu's "Check tags after sync" in a Vite build of the real
 * `SidebarToolbar` (`harness/sync-menu`): a toggle that stays open, between
 * the interval and Show last run, whose hint wraps inside the menu.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("Check tags after sync in the sync menu", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-sync-menu-"));
  const html = await buildHarness("sync-menu", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "420", PWRGIT_HARNESS_HEIGHT: "720" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const open = async (view: string, theme: string): Promise<void> => {
      await mount(page, view, theme);
      await page.getByRole("button", { name: "Sync options" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      // The menu fades in; a shot mid-animation reads as disabled text.
      await page.getByRole("menu").evaluate((menu) => Promise.all(menu.getAnimations().map((animation) => animation.finished)));
    };
    const shoot = async (name: string): Promise<void> => {
      if (!shots) return;
      await page.mouse.move(0, 0);
      const menu = (await page.getByRole("menu").boundingBox())!;
      await page.screenshot({
        path: join(shots, `${name}.png`),
        clip: { x: 0, y: 0, width: Math.ceil(Math.max(320, menu.x + menu.width + 12)), height: Math.ceil(menu.y + menu.height + 12) }
      });
    };

    for (const theme of ["dark", "light"]) {
      await open("before", theme);
      await expect(page.getByRole("menuitemcheckbox")).toHaveCount(0);
      await shoot(`before-${theme}`);

      await open("on", theme);
      const toggle = page.getByRole("menuitemcheckbox", { name: /Check tags after sync/ });
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      // The hint wraps inside the menu; nothing is cut off or pushes it wide.
      const fits = await toggle.evaluate((el) => {
        const menu = el.closest('[role="menu"]')!.getBoundingClientRect();
        const hint = el.querySelector(".pop-menu__hint")!;
        const box = hint.getBoundingClientRect();
        return box.right <= menu.right && hint.scrollWidth <= hint.clientWidth + 1 && menu.right <= window.innerWidth;
      });
      expect(fits).toBe(true);
      // Its place: after the interval group, before Show last run.
      const order = await page.getByRole("menu").evaluate((menu) =>
        [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => (el.querySelector(".pop-menu__stack > span:first-child") ?? el).textContent)
      );
      expect(order.slice(-3)).toEqual(["Every hour", "Check tags after sync", "Show last run"]);
      await shoot(`after-${theme}`);

      // A setting: the menu stays open and the check follows.
      await toggle.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(await calls(page)).toEqual(["tagCheckAfterSync:false"]);
      await shoot(`after-off-${theme}`);
    }
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
