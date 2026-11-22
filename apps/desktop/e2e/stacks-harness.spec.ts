import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

test("shows stack positions and navigates between the stack and lineage", async () => {
  const out = mkdtempSync(join(tmpdir(), "pwrgit-stacks-harness-"));
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  try {
    const html = await buildHarness("stacks", join(out, "dist"));
    const app = await electron.launch({
      args: ["--disable-accelerated-video-decode", "--disable-accelerated-video-encode",
        join(dirname(fileURLToPath(import.meta.url)), "harness", "electron-main.cjs")],
      env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "1070", PWRGIT_HARNESS_HEIGHT: "690" }),
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByText("Register Windows workers").first()).toBeVisible();
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, "stack-before.png") });
      }
      await page.evaluate(() => (window as unknown as { showStacks(): void }).showStacks());
      await expect(page.getByText("2 to restack")).toBeVisible();
      const graphPosition = page.locator(".graph-row").getByRole("button", { name: "Open stack for windows/api, position 2 of 3" });
      await expect(graphPosition).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-lineage.png") });
      await graphPosition.click();
      await expect(page.getByRole("region", { name: "Stack", exact: true })).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Stack health" })).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-view.png") });
      await page.getByRole("button", { name: "Back to worktree" }).click();
      await expect(graphPosition).toBeVisible();
      await graphPosition.click();
      await page.evaluate(() => (window as unknown as { showOperations(): void }).showOperations());
      await page.getByRole("button", { name: "Restack", exact: true }).click();
      await expect(page.getByRole("complementary", { name: "Stack operation plan" })).toBeVisible();
      await expect(page.getByText("1 patch preserved")).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-plan.png"), animations: "disabled" });
      await page.getByRole("button", { name: "Run locally" }).click();
      await expect(page.getByRole("complementary", { name: "Proof ledger" })).toBeVisible();
      await expect(page.getByText("2 patches preserved")).toBeVisible();
      await expect(page.getByText("2 to restack")).toHaveCount(0);
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-proof.png"), animations: "disabled" });
      await undo.click();
      await expect(page.getByText("2 to restack")).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Proof ledger" })).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
