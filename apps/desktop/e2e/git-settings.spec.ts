import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

const VIEWS = ["update", "downloading", "ready", "rollback", "failed", "offline", "chosen-by-path", "needs-app", "unpromoted", "prerelease"] as const;
type View = "general" | (typeof VIEWS)[number];

const mount = (page: Page, view: View): Promise<void> =>
  page.evaluate((name) => {
    (window as unknown as { __harness: { mount: (view: string) => void } }).__harness.mount(name);
  }, view);

/**
 * The window's content size, as the Settings window would be resized. The
 * page is also pinned to the width itself: a hidden window's resize lands
 * asynchronously on Linux CI, and a check that ran before it measured the
 * old width.
 */
async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w!, h!), [width, height]);
  const page = await app.firstWindow();
  await page.evaluate(async (w) => {
    document.getElementById("root")!.style.width = `${w}px`;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, width);
}

/**
 * Settings › Git, in a Vite build of the real Settings window against a fake
 * bridge (`harness/git-settings`). Design: "Git Settings and Managed Updates -
 * UX Review", turns 2–4.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("Settings › Git lays out every PwrGit’s Git state, down to the 760px window minimum", async () => {
  test.setTimeout(180_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-git-settings-"));
  const html = await buildHarness("git-settings", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "980", PWRGIT_HARNESS_HEIGHT: "720" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
    const managed = page.locator("section[aria-label='PwrGit’s Git']");
    const chip = managed.locator(".settings-panel__header .settings-card__chip");

    /** Every card on screen at once: the window grows to the pane's height. */
    const shoot = async (name: string, width: number): Promise<void> => {
      if (!shots) return;
      const height = await page.locator(".settings-content").evaluate((el) => el.scrollHeight + 60);
      await resize(app, width, Math.max(720, height));
      await page.mouse.move(0, 0);
      await page.locator(".settings-screen").screenshot({ path: join(shots, `${name}.png`) });
      await resize(app, width, 720);
    };

    /** Nothing in the pane is wider than the pane. */
    const noOverflow = async (): Promise<void> => {
      const overflow = await page.locator(".settings-content").evaluate((el) => {
        const limit = el.getBoundingClientRect().right;
        return [...el.querySelectorAll<HTMLElement>("*")]
          .filter((node) => node.getBoundingClientRect().right > limit + 0.5 && node.getClientRects().length > 0)
          .map((node) => `${node.className || node.tagName}: ${node.textContent?.slice(0, 40)}`);
      });
      expect(overflow).toEqual([]);
    };

    await mount(page, "general");
    await expect(page.locator(".settings-nav__button").nth(1)).toHaveText("Git");
    await expect(page.locator("section[aria-label='In use']")).toHaveCount(0);
    await shoot("general", 980);

    const expected: Record<(typeof VIEWS)[number], string> = {
      update: "Update available",
      downloading: "Downloading 41%",
      ready: "Ready to use",
      rollback: "Up to date",
      failed: "Failed",
      offline: "Couldn’t check",
      "chosen-by-path": "Ready to use",
      "needs-app": "Up to date",
      unpromoted: "Up to date",
      prerelease: "Update available"
    };
    for (const view of VIEWS) {
      await resize(app, 980, 720);
      await mount(page, view);
      await expect(chip).toHaveText(expected[view]);
      await expect(page.locator("section[aria-label='In use'] .settings-field__value").first()).toBeVisible();
      await noOverflow();
      // The nav names the card in full beside its word: a chip may not push
      // "PwrGit’s Git" into an ellipsis.
      const truncated = await page.locator(".settings-nav__sublabel").evaluateAll((labels) =>
        labels
          .filter((label) => label.scrollWidth > label.clientWidth)
          .map((label) => `${label.textContent} (${label.scrollWidth}px in ${label.clientWidth}px)`)
      );
      expect(truncated, view).toEqual([]);
      await shoot(`git-${view}`, 980);
    }

    // The nav's child carries the card's answer.
    await mount(page, "update");
    const child = page.locator(".settings-nav__subbutton", { hasText: "PwrGit’s Git" });
    await expect(child.locator(".settings-nav__subdot--accent")).toHaveCount(1);
    await expect(child.locator(".settings-nav__subchip")).toHaveText("new");

    // The Build track names each track's build, and says which is followed.
    await mount(page, "prerelease");
    const track = managed.getByRole("radiogroup", { name: "Build track" });
    await expect(track.getByRole("radio", { name: /Prerelease/ })).toHaveAttribute("aria-checked", "true");
    await expect(track.getByRole("radio", { name: /Latest/ })).toContainText("2.56.0-dev-pwrgit.5");

    // The window minimum: the Git page folds each label above its control;
    // other panes keep their side-by-side rows.
    for (const view of ["downloading", "chosen-by-path", "rollback", "prerelease"] as const) {
      await resize(app, 760, 720);
      await mount(page, view);
      await expect(chip).toHaveText(expected[view]);
      await noOverflow();
      const stacked = await managed.locator(".settings-field").first().evaluate((field) => {
        const label = field.querySelector(".settings-field__label")!.getBoundingClientRect();
        const control = field.querySelector(".settings-field__control")!.getBoundingClientRect();
        return label.bottom <= control.top + 0.5;
      });
      expect(stacked).toBe(true);
      await shoot(`git-${view}-760`, 760);
    }
    await resize(app, 760, 720);
    await mount(page, "general");
    const sideBySide = await page.locator(".settings-field").first().evaluate((field) => {
      const label = field.querySelector(".settings-field__label")!.getBoundingClientRect();
      const control = field.querySelector(".settings-field__control")!.getBoundingClientRect();
      return label.right <= control.left;
    });
    expect(sideBySide).toBe(true);
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
