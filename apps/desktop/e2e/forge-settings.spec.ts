import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

const VIEWS = ["cross-cli", "reassigned-saas"] as const;

const mount = (page: Page, view: (typeof VIEWS)[number]): Promise<void> =>
  page.evaluate((name) => {
    (window as unknown as { __harness: { mount: (view: string) => void } }).__harness.mount(name);
  }, view);

/**
 * Settings › Forges, in a Vite build of the real Settings window whose rows and
 * probe targets come from main's real `ForgeHosts` (`harness/forge-settings`).
 * Each view is a shrunk counterexample from `forge-surfaces.property.test.ts`,
 * checked here as the reader sees it: a GitLab card never says a host is
 * signed in while its chip says nothing GitLab can read, or the reverse.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each view as a PNG there.
 */
test("Settings › Forges never contradicts itself about a GitLab host", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-forge-settings-"));
  const html = await buildHarness("forge-settings", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "980", PWRGIT_HARNESS_HEIGHT: "900" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
    const gitlab = page.locator("section[aria-label='GitLab']");
    const chip = gitlab.locator(".settings-panel__header .settings-card__chip");

    const show = async (view: (typeof VIEWS)[number]): Promise<void> => {
      await mount(page, view);
      await expect(chip).toBeVisible();
      await expect(gitlab).not.toContainText("Checking…");
      if (shots) {
        await page.mouse.move(0, 0);
        await page.locator(".settings-screen").screenshot({ path: join(shots, `${view}.png`) });
      }
    };

    // gh reports a host the user added as GitLab. glab holds nothing there,
    // so the row must not say a GitLab account is signed in under a
    // "Signed out" chip.
    await show("cross-cli");
    await expect(chip).toHaveText("Signed out");
    await expect(gitlab).not.toContainText("signed in as");
    await expect(gitlab).toContainText("glab auth login --hostname code.acme.example");

    // An env allowlist gives gitlab.com to GitHub. No route reads it as
    // GitLab, so the GitLab card must not claim it is connected.
    await show("reassigned-saas");
    await expect(chip).not.toHaveText("Connected");
  } finally {
    await app.close();
  }
});
