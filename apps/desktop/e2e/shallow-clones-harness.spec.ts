import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = { ready: Promise<void>; mount: (scene: string, theme: string) => void };
const mount = (page: Page, scene: string, theme: string): Promise<void> =>
  page.evaluate(([s, t]) => (window as unknown as { __harness: Harness }).__harness.mount(s, t), [scene, theme] as const);

/**
 * Limited-history clones in a Vite build of the real components
 * (`harness/shallow-clones`, design/Shallow Clones - UX Review): the Clone
 * dialog's "Recent history only" row off, on and invalid, and History's
 * boundary chip and note. Contrived data. `PWRGIT_HARNESS_SHOTS=<dir>` writes
 * each state as a PNG.
 */
test("limited-history clone surfaces render and say what the board says", async () => {
  test.setTimeout(180_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-shallow-clones-"));
  const html = await buildHarness("shallow-clones", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1000", PWRGIT_HARNESS_HEIGHT: "900" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const shoot = async (name: string, selector: string) => {
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
      if (!shots) return;
      await page.mouse.move(999, 899);
      await page.locator(selector).first().screenshot({ path: join(shots, `${name}.png`) });
    };

    for (const theme of ["dark", "light"]) {
      await mount(page, "clone", theme);
      await page.locator("#clone-source").fill("acme/api");
      await page.locator(".clone-source-row").first().click();
      const row = page.locator(".clone-history");
      const submit = page.locator(".clone-dialog__submit");
      await expect(row).toContainText("Recent history only");
      await expect(row.locator("input[type=checkbox]")).not.toBeChecked();
      await expect(submit).toBeEnabled();
      await shoot(`clone-off-${theme}`, ".clone-dialog");

      await row.locator("input[type=checkbox]").check();
      await expect(row.getByRole("textbox", { name: "Commits per branch" })).toHaveValue("50");
      await expect(submit).toBeEnabled();
      await shoot(`clone-on-${theme}`, ".clone-dialog");

      await row.getByRole("textbox", { name: "Commits per branch" }).fill("0");
      await expect(row).toContainText("Enter a whole number of commits from 1 to 100,000.");
      await expect(submit).toBeDisabled();
      await shoot(`clone-invalid-${theme}`, ".clone-dialog");

      await mount(page, "graph", theme);
      await expect(page.locator(".commit-tag--shallow")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Fetch 100 older commits" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Fetch full history" })).toBeEnabled();
      await shoot(`graph-shallow-${theme}`, ".graph-harness");

      await mount(page, "graph-single", theme);
      await expect(page.locator(".graph-shallow-note")).toContainText("fetches only main from origin");
      await shoot(`graph-single-${theme}`, ".graph-harness");

      await mount(page, "graph-complete", theme);
      await expect(page.locator(".commit-tag--shallow")).toHaveCount(0);
      await expect(page.locator(".graph-shallow-note")).toHaveCount(0);
    }
  } finally {
    await app.close();
  }
});
