import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = {
  ready: Promise<void>;
  mount: (view: string) => void;
  progress: () => void;
  finish: () => void;
};
const call = (page: Page, method: "mount" | "progress" | "advance" | "finish", arg?: string): Promise<void> =>
  page.evaluate(
    ([name, value]) => {
      const h = (window as unknown as { __harness: Record<string, (v?: string) => void> }).__harness;
      h[name!]!(value);
    },
    [method, arg] as const
  );

/**
 * Copy-on-write clones, in a Vite build of the real Settings card and
 * Maintenance dialog against a fake bridge (`harness/reflink-clones`).
 * Design: "Refresh Clones - UX Review", turns 1 and 2.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("copy-on-write switch and Maintenance › Clones lay out without overflow", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-reflink-clones-"));
  const html = await buildHarness("reflink-clones", join(out, "dist"));
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
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);

    const shoot = async (name: string, selector: string): Promise<void> => {
      if (!shots) return;
      await page.mouse.move(0, 0);
      await page.locator(selector).first().screenshot({ path: join(shots, `${name}.png`) });
    };

    // Settings: before (no switch), PwrGit's Git (works), Homebrew (disabled).
    await call(page, "mount", "settings-before");
    await expect(page.getByText("Git LFS", { exact: true })).toBeVisible();
    await shoot("settings-before", ".settings-harness");
    await call(page, "mount", "settings-pwrgit");
    const toggle = page.getByRole("switch", { name: "Copy-on-write checkout" });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await shoot("settings-pwrgit", ".settings-harness");
    await call(page, "mount", "settings-homebrew");
    await expect(page.getByRole("switch", { name: "Copy-on-write checkout" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Use PwrGit’s Git" })).toBeVisible();
    await shoot("settings-homebrew", ".settings-harness");

    // Maintenance › Clones: setup, running, receipt, unavailable.
    await call(page, "mount", "clones");
    const dialog = page.getByRole("dialog", { name: "Repository maintenance" });
    await expect(dialog.getByRole("button", { name: "Clones", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "Refresh clones" })).toBeEnabled();
    await shoot("clones-setup", ".modal");
    await dialog.getByRole("button", { name: "Refresh clones" }).click();
    await call(page, "progress");
    await expect(dialog).toContainText("Refreshing clones in 2 repositories");
    await expect(dialog).toContainText("3 of 14 repositories");
    await expect(dialog).toContainText("Worktree 2 of 3 · fix/retry-jitter");
    await expect(dialog).toContainText("3 repositories have no linked worktrees, so nothing to share");
    await shoot("clones-running", ".modal");
    // The live card stays in view while the rows scroll under it.
    const body = dialog.locator(".maintenance__body");
    expect(await body.evaluate((node) => {
      node.scrollTo({ top: node.scrollHeight });
      return node.scrollTop;
    })).toBeGreaterThan(100);
    await shoot("clones-running-scrolled", ".modal");
    const card = await dialog.locator(".bulk-sync__status.is-live").boundingBox();
    const view = await body.boundingBox();
    expect(card !== null && view !== null && card.y >= view.y - 1 && card.y + card.height <= view.y + view.height).toBe(true);
    await body.evaluate((node) => node.scrollTo({ top: 0 }));
    await call(page, "finish");
    const status = dialog.locator(".maintenance__done-status");
    await expect(status).toContainText("987.0 MiB of file data now shared with main checkouts");
    // Largest share first, then expand it to its worktrees.
    await expect(dialog.locator(".maintenance__clones-name strong").first()).toHaveText("lumen-api");
    await dialog.locator(".maintenance__clones-row summary").first().click();
    await expect(dialog).toContainText("3,810 files re-shared · 2 left as they are (2 changed).");
    // Two clones named atlas: each row names its path.
    await expect(dialog.locator(".maintenance__clones-name code")).toHaveText(["/Users/demo/src/atlas", "/Users/demo/forks/atlas"]);
    await expect(dialog.locator(".maintenance__clones-row strong", { hasText: "notes" })).toHaveCount(0);
    // Every row keeps its text inside its box.
    const overflow = await dialog.locator(".maintenance__clones-rows").evaluate((list) =>
      Array.from(list.querySelectorAll<HTMLElement>("summary, li, small, code")).filter(
        (node) => node.scrollWidth > node.clientWidth + 1
      ).length
    );
    expect(overflow).toBe(0);
    await shoot("clones-receipt", ".modal");
    await call(page, "mount", "clones-unavailable");
    await expect(page.getByText("Refreshing clones needs PwrGit’s Git")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh clones" })).toBeDisabled();
    await shoot("clones-unavailable", ".modal");

    // After a window reload: main's run went on without a dialog. The
    // reopened dialog (no tab named) finds it and picks it up.
    await call(page, "mount", "reattach-running");
    await expect(dialog.getByRole("button", { name: "Clones", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).toContainText("Refreshing clones in 2 repositories");
    await expect(dialog).toContainText("3 of 14 repositories");
    await expect(dialog).toContainText("Worktree 2 of 3 · fix/retry-jitter");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await call(page, "advance");
    await expect(dialog).toContainText("Worktree 3 of 3 · spike/grpc");
    await shoot("reattach-running", ".modal");
    await call(page, "finish");
    await expect(dialog.locator(".maintenance__done-status")).toContainText("987.0 MiB of file data now shared with main checkouts");
    // A run that ended while no dialog was open shows the same receipt.
    await call(page, "mount", "reattach-finished");
    await expect(dialog.locator(".maintenance__done-status")).toContainText("987.0 MiB of file data now shared with main checkouts");
    await expect(dialog.locator(".maintenance__done-status")).toContainText("took 16m 42s");
    await shoot("reattach-finished", ".modal");
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
