import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type MountOptions = { width?: number; step?: string; search?: string; roots?: string[] };
type Harness = { ready: Promise<void>; mount: (scene: string, theme: string, opts?: MountOptions) => void };
const mount = (page: Page, scene: string, theme: string, opts: MountOptions = {}): Promise<void> =>
  page.evaluate(
    ([s, t, o]) => (window as unknown as { __harness: Harness }).__harness.mount(s, t, o),
    [scene, theme, opts] as const
  );

/**
 * The new-user journey in a Vite build of the real components
 * (`harness/new-user-journey`, design/New User Journey - UX Review): the start
 * screen in both states, Add ▾ with Find repositories…, the wizard's step 3
 * screens and its no-repositories Done, and Clone with no folder. Contrived
 * data throughout. `PWRGIT_HARNESS_SHOTS=<dir>` writes each state as a PNG.
 */
test("the new-user journey's surfaces render and say what the board says", async () => {
  test.setTimeout(180_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-new-user-journey-"));
  const html = await buildHarness("new-user-journey", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1100", PWRGIT_HARNESS_HEIGHT: "960" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const settle = () =>
      page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    const shoot = async (name: string, clip?: { x: number; y: number; width: number; height: number }) => {
      await settle();
      if (!shots) return;
      await page.mouse.move(1099, 959);
      await page.screenshot({ path: join(shots, `${name}.png`), ...(clip ? { clip } : {}) });
    };
    const shootLocator = async (name: string, selector: string, pad = 0) => {
      await settle();
      const box = (await page.locator(selector).first().boundingBox())!;
      await shoot(name, {
        x: Math.max(0, Math.floor(box.x - pad)),
        y: Math.max(0, Math.floor(box.y - pad)),
        width: Math.ceil(box.width + 2 * pad),
        height: Math.ceil(box.height + 2 * pad)
      });
    };

    for (const theme of ["dark", "light"]) {
      // 4a: no folders.
      await mount(page, "window", theme);
      await expect(page.getByRole("heading", { name: "Add your repositories" })).toBeVisible();
      await expect(page.getByTestId("sidebar")).toContainText("No repositories yet.");
      await expect(page.getByText("No commit author and no forge sign-in yet.")).toBeVisible();
      await shoot(`start-4a-${theme}`, { x: 0, y: 0, width: 1100, height: 640 });

      // 4b: one folder, nothing in it.
      await mount(page, "window-folder", theme, { roots: ["/Users/dana/projects"] });
      await expect(page.getByRole("heading", { name: "Nothing in ~/projects yet" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Clone into ~\/projects…/ })).toBeVisible();
      await shoot(`start-4b-${theme}`, { x: 0, y: 0, width: 1100, height: 640 });

      // Find my repositories, from the start screen.
      await mount(page, "window-search", theme);
      await expect(page.getByText("Found 17 repositories in 4 folders.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add 4 folders" })).toBeEnabled();
      await shoot(`start-find-${theme}`, { x: 0, y: 0, width: 1100, height: 640 });

      // Narrow pane: the doors fall to one column.
      await mount(page, "pane", theme, { width: 420 });
      const doors = page.locator(".start-door");
      const xs = await doors.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
      expect(new Set(xs).size).toBe(1);
      await shoot(`start-narrow-${theme}`, { x: 0, y: 0, width: 420, height: 640 });

      // Add ▾ with Find repositories… first.
      await mount(page, "menu", theme);
      await page.getByRole("button", { name: "Add repositories" }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const labels = await menu.evaluate((el) =>
        [...el.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
      );
      expect(labels).toEqual(["Find repositories…", "Add folders…", "Rescan foldersAdd a repo folder first", "Clone…", "Fork…"]);
      await settle();
      const menuBox = (await menu.boundingBox())!;
      await shoot(`add-menu-${theme}`, { x: 0, y: 0, width: 340, height: Math.ceil(menuBox.y + menuBox.height + 12) });

      // Wizard step 3: the three-way choice (3a).
      await mount(page, "wizard", theme, { step: "repos-choose" });
      await expect(page.getByText("Step 3 — Repositories")).toBeVisible();
      await shootLocator(`wizard-3a-${theme}`, ".onboarding-wizard", 0);

      // 2b: the checklist.
      await page.getByText("Find them for me").click();
      await page.getByRole("button", { name: "Find my repositories" }).click();
      await expect(page.getByText("Found 17 repositories in 4 folders.")).toBeVisible();
      await shootLocator(`wizard-2b-${theme}`, ".onboarding-wizard", 0);

      // 2c: still looking, and nothing found.
      await mount(page, "wizard", theme, { step: "repos-choose", search: "running" });
      await page.getByRole("button", { name: "Find my repositories" }).click();
      await expect(page.getByText("212 folders opened, 14 repositories so far.")).toBeVisible();
      await expect(page.getByRole("button", { name: /^Add folders/ })).toBeDisabled();
      await shootLocator(`wizard-2c-running-${theme}`, ".onboarding-wizard", 0);
      await mount(page, "wizard", theme, { step: "repos-choose", search: "nothing" });
      await page.getByRole("button", { name: "Find my repositories" }).click();
      await expect(page.getByText("No repositories within three folders of home.")).toBeVisible();
      await shootLocator(`wizard-2c-nothing-${theme}`, ".onboarding-wizard", 0);

      // 3b: "I do not have any" picks and creates a folder, then 3c.
      await mount(page, "wizard", theme, { step: "repos-choose" });
      await page.getByText("I do not have any on this computer").click();
      await expect(page.getByRole("radio", { name: /I do not have any/ })).toBeChecked();
      await page.getByRole("button", { name: "Pick a folder" }).click();
      await expect(page.getByRole("button", { name: "Create ~/projects" })).toBeVisible();
      await shootLocator(`wizard-3b-${theme}`, ".onboarding-wizard", 0);
      await page.getByRole("button", { name: "Create ~/projects" }).click();
      await expect(page.getByText("~/projects is ready. Put a repository in it.")).toBeVisible();
      await shootLocator(`wizard-3c-${theme}`, ".onboarding-wizard", 0);

      // Clone with no folder: where should it go?
      await mount(page, "clone", theme);
      await page.locator("#clone-source").fill("acme/atlas");
      await page.locator(".clone-source-row").first().click();
      await expect(page.getByText("Where should it go?")).toBeVisible();
      await shootLocator(`clone-no-folder-${theme}`, ".clone-dialog", 12);
    }
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
