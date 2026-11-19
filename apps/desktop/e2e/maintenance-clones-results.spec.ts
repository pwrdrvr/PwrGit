import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

/**
 * Combined maintenance's Clones card when Git failed in some worktrees,
 * measured in a Vite build of the real dialog against a fake bridge
 * (`harness/maintenance-clones`). Design: "Maintenance Continues Past
 * Errors - UX Review", turn 4: one row per failed worktree with its path,
 * Git's words behind Details, Copy per row and Copy all on the card.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes `maintenance-clones.png`,
 * `maintenance-clones-details.png` and `maintenance-clones-many.png`.
 */
type Harness = { ready: Promise<void>; copied: string[]; many: () => void };
const harness = (page: Page) => page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.copied);

test("Clones failures name each worktree, show Git's words, and copy", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-maintenance-clones-"));
  const html = await buildHarness("maintenance-clones", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1100", PWRGIT_HARNESS_HEIGHT: "900" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  const shoot = async (page: Page, name: string): Promise<void> => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await page.mouse.move(0, 0);
    // The dialog fades in; shoot it settled.
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    await page.screenshot({ path: join(shots, name) });
  };
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const status = page.locator(".maintenance__done-status");
    await expect(status).toContainText("Maintenance finished with errors");
    await shoot(page, "maintenance-clones.png");

    const card = page.getByRole("alert", { name: "2 worktrees couldn’t be re-shared in 2 repositories" });
    await expect(card).toContainText("The other 2 worktrees had no errors.");
    const rows = card.locator(".maintenance__problem-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("docs-site · docs/refresh-guides");
    await expect(rows.nth(0)).toContainText("/Users/dana/src/docs-site-worktrees/refresh-guides");
    await expect(rows.nth(0)).toContainText("Git couldn’t open this worktree.");
    await expect(rows.nth(1)).toContainText("lumen-api · agent/quiet-heron");
    await expect(rows.nth(1)).toContainText("3 files re-shared · 2 files failed.");
    // The counts are kept, and agree with the rows.
    await expect(page.locator(".maintenance__receipt-step").filter({ hasText: "Clones" })).toContainText("4 worktrees · 2 failed");

    await rows.nth(0).getByRole("button", { name: "Details" }).click();
    await expect(rows.nth(0).locator("pre")).toHaveText(
      "fatal: gitfile does not point to a valid repository: /Users/dana/src/docs-site-worktrees/refresh-guides/.git\nExit code 128 · git worktree reflink --porcelain -z");
    await rows.nth(0).getByRole("button", { name: "Copy" }).click();
    await expect(rows.nth(0).getByRole("button", { name: "Copied" })).toBeVisible();
    await shoot(page, "maintenance-clones-details.png");
    const [one] = await harness(page);
    expect(one).toContain("Worktree: /Users/dana/src/docs-site-worktrees/refresh-guides");
    expect(one).toContain("Exit code: 128");

    // Six failures in three repositories: the rows scroll under a fixed head,
    // and Copy all takes every one.
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.many());
    const all = page.getByRole("alert", { name: "6 worktrees couldn’t be re-shared in 3 repositories" });
    await expect(all).toBeVisible();
    const list = all.getByRole("list", { name: "Worktrees not re-shared" });
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await shoot(page, "maintenance-clones-many.png");
    await all.getByRole("button", { name: "Copy all" }).click();
    const copied = (await harness(page)).at(-1)!;
    expect(copied.startsWith("6 worktrees couldn’t be re-shared in 3 repositories")).toBe(true);
    for (const path of ["refresh-guides", "changelog", "quiet-heron", "route-cache", "brisk-otter", "calm-finch"]) {
      expect(copied).toContain(`-worktrees/${path}\n`);
    }
    await expect(all.locator(".maintenance__problem-head")).toBeInViewport();
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
