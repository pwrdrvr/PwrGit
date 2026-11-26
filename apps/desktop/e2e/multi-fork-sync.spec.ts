import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { multiForkHarness } from "./harness/multi-fork-sync/main";

declare global {
  interface Window {
    multiForkHarness: typeof multiForkHarness;
  }
}

let out: string;
let app: ElectronApplication;
let page: Page;

const shotsDir = process.env["PWRGIT_HARNESS_SHOTS"];

test.beforeAll(async () => {
  out = mkdtempSync(`${tmpdir()}/pwrgit-multi-fork-harness-`);
  const html = await buildHarness("multi-fork-sync", `${out}/dist`);
  app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      fileURLToPath(new URL("./harness/electron-main.cjs", import.meta.url))
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html })
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 920, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => "multiForkHarness" in window);
  await page.evaluate(() => window.multiForkHarness.ready);
});

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

test("renders multi-fork Pull menu targets and live toggle", async () => {
  if (shotsDir !== undefined) {
    mkdirSync(shotsDir, { recursive: true });
    await page.evaluate(() => window.multiForkHarness.mount("pull-before"));
    await page.locator(".wt-split__caret").click();
    await expect(page.locator(".pull-menu")).toBeVisible();
    await page.locator(".shot-frame").screenshot({
      path: join(shotsDir, "pull-menu-before.png")
    });
  }

  await page.evaluate(() => window.multiForkHarness.mount("pull-after"));
  await page.locator(".wt-split__caret").click();
  const menu = page.locator(".pull-menu");
  await expect(menu).toBeVisible();

  const checkboxes = menu.getByRole("menuitemcheckbox");
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(checkboxes.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(menu).toContainText("northwind/canvas");
  await expect(menu).toContainText("riverbend/canvas");

  if (shotsDir !== undefined) {
    await page.locator(".shot-frame").screenshot({
      path: join(shotsDir, "pull-menu-after.png")
    });
  }

  // The checklist sits under the route it edits. A toggle that reflowed the
  // route moved every checkbox out from under the pointer (26px), so a second
  // click landed on the neighbouring fork. Each toggle state must leave every
  // checkbox where it was.
  const rows = async (): Promise<number[]> =>
    Promise.all(
      [0, 1].map(async (i) => (await checkboxes.nth(i).boundingBox())?.y ?? NaN)
    );
  const at = await rows();
  for (const [index, checked] of [
    [1, "false"],
    [0, "false"],
    [1, "true"],
    [0, "true"]
  ] as const) {
    await checkboxes.nth(index).click();
    await expect(checkboxes.nth(index)).toHaveAttribute("aria-checked", checked);
    expect(await rows()).toEqual(at);
    if (shotsDir !== undefined && index === 1 && checked === "false") {
      await page.locator(".shot-frame").screenshot({
        path: join(shotsDir, "pull-menu-unchecked.png")
      });
    }
  }
});

test("renders Remotes tab writable fork badges and opt-out toggles", async () => {
  if (shotsDir !== undefined) {
    mkdirSync(shotsDir, { recursive: true });
    await page.evaluate(() => window.multiForkHarness.mount("remotes-before"));
    await expect(page.locator(".refs-remotes")).toBeVisible();
    await page.locator(".refs-browser").screenshot({
      path: join(shotsDir, "remotes-tab-before.png")
    });
  }

  await page.evaluate(() => window.multiForkHarness.mount("remotes-after"));
  await expect(page.locator(".refs-remotes")).toBeVisible();

  const toggles = page.locator(".refs-remote-card__sync input");
  await expect(toggles).toHaveCount(2);
  await expect(toggles.nth(0)).toBeChecked();
  await expect(toggles.nth(1)).toBeChecked();

  if (shotsDir !== undefined) {
    await page.locator(".refs-browser").screenshot({
      path: join(shotsDir, "remotes-tab-after.png")
    });
  }

  // The card's checkbox draws the house ring, not Chromium's 1px fallback.
  await toggles.nth(0).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(toggles.nth(0)).toBeFocused();
  expect(
    await toggles.nth(0).evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    })
  ).toBe("solid 2px");

  await toggles.nth(1).click();
  await expect(toggles.nth(1)).not.toBeChecked();
});

test("shows the route for a disabled sole fork", async () => {
  await page.evaluate(() => window.multiForkHarness.mount("pull-disabled"));
  await page.locator(".wt-split__caret").click();
  const menu = page.locator(".pull-menu");
  await expect(menu).toBeVisible();
  if (shotsDir !== undefined) {
    mkdirSync(shotsDir, { recursive: true });
    await page.locator(".shot-frame").screenshot({
      path: join(shotsDir, "pull-disabled.png")
    });
  }
  await expect(menu).toContainText("No fork remotes are enabled for push.");
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(0);
});
