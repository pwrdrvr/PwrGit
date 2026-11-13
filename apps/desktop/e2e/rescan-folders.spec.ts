import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = {
  ready: Promise<void>;
  calls: string[];
  mount: (theme: string) => void;
  toast: (found: string) => void;
};
const mount = (page: Page, theme: string): Promise<void> =>
  page.evaluate((t) => (window as unknown as { __harness: Harness }).__harness.mount(t), theme);
const raise = (page: Page, found: string): Promise<void> =>
  page.evaluate((f) => (window as unknown as { __harness: Harness }).__harness.toast(f), found);
const calls = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { __harness: Harness }).__harness.calls]);

/**
 * Add ▾ → Rescan folders in a Vite build of the real `SidebarToolbar` and
 * `ToastHost` (`harness/rescan-folders`): the entry sits beside Add folders,
 * runs its handler, and each answer reads as a toast that names what turned
 * up.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("Rescan folders in the Add menu, and what it says", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-rescan-folders-"));
  const html = await buildHarness("rescan-folders", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "760", PWRGIT_HARNESS_HEIGHT: "560" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const shootBox = async (name: string, box: { x: number; y: number; width: number; height: number }) => {
      if (!shots) return;
      await page.mouse.move(0, 0);
      const pad = 12;
      await page.screenshot({
        path: join(shots, `${name}.png`),
        clip: {
          x: Math.max(0, Math.floor(box.x - pad)),
          y: Math.max(0, Math.floor(box.y - pad)),
          width: Math.ceil(box.width + 2 * pad),
          height: Math.ceil(box.height + 2 * pad)
        }
      });
    };

    for (const theme of ["dark", "light"]) {
      await mount(page, theme);
      await page.getByRole("button", { name: "Add repositories" }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const labels = await menu.evaluate((el) =>
        [...el.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
      );
      const menuBox = (await menu.boundingBox())!;
      if (shots) {
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: join(shots, `menu-${theme}.png`),
          clip: { x: 0, y: 0, width: 340, height: Math.ceil(menuBox.y + menuBox.height + 12) }
        });
      }
      expect(labels).toEqual(["Find repositories…", "Add folders…", "Rescan folders", "Clone…", "Fork…"]);
      await page.getByRole("menuitem", { name: "Rescan folders" }).click();
      expect(await calls(page)).toEqual(["rescanFolders"]);

      for (const found of ["scanning", "one", "several", "none"]) {
        await raise(page, found);
        const card = page.locator(".app-toast").last();
        await expect(card).toBeVisible();
        await card.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
        // One key: each answer replaces the card rather than stacking.
        await expect(page.locator(".app-toast")).toHaveCount(1);
        const expected = {
          scanning: "Rescanning folders…",
          one: "New repository",
          several: "6 new repositories",
          none: "No new repositories"
        }[found]!;
        await expect(card).toContainText(expected);
        await shootBox(`toast-${found}-${theme}`, (await card.boundingBox())!);
      }
    }
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
