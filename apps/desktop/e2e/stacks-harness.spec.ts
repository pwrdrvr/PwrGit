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
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await expect(page.getByText("Register Windows workers").first()).toBeVisible();
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, "stack-before.png") });
      }
      await page.evaluate(() => (window as unknown as { showStacks(): void }).showStacks());
      await page.getByRole("combobox", { name: "Pull request order" }).selectOption("stack");
      await expect(page.locator(".stack-group__caption").getByText("Restack")).toBeVisible();
      await expect(page.locator(".stack-sidebar .ref-section__head")).toHaveAttribute("aria-expanded", "false");
      const graphPosition = page.locator(".graph-row").getByRole("button", { name: "windows/scheduler, position 2 of 3. Show stack" });
      await expect(graphPosition).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-lineage.png") });
      const prHead = page.locator(".ref-cr-section .ref-section__head");
      const stacksHead = page.locator(".stack-sidebar .ref-section__head");
      await prHead.click();
      await expect(prHead).toHaveAttribute("aria-expanded", "false");
      if (shots) await page.locator(".pane--sidebar").screenshot({ path: join(shots, "stack-prs-collapsed.png") });
      await expect(stacksHead).toHaveAttribute("aria-expanded", "false");
      await prHead.click();
      await expect(prHead).toHaveAttribute("aria-expanded", "true");
      await graphPosition.hover();
      const branchTooltip = page.getByRole("tooltip").filter({ hasText: "windows/api" });
      await expect(branchTooltip).toBeVisible();
      await graphPosition.click();
      await expect(branchTooltip).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "windows/scheduler" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.locator(".stack-group__caption").press("Space");
      await expect(page.getByRole("dialog", { name: "windows/scheduler" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Stack", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      const refBrowser = page.getByRole("region", { name: "Refs at 2222222" });
      await page.getByRole("button", { name: "Browse 2 refs at 2222222" }).click();
      await refBrowser.getByRole("button", { name: "windows/scheduler, position 2 of 3. Show stack" }).click();
      const nestedStack = refBrowser.getByRole("dialog", { name: "windows/scheduler" });
      await expect(nestedStack).toBeVisible();
      await expect(page.getByRole("region", { name: "Stack", exact: true })).toHaveCount(0);
      const closeStack = nestedStack.getByRole("button", { name: "Close stack popover" });
      const openView = nestedStack.getByRole("button", { name: "Open stack view" });
      await closeStack.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(openView).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(closeStack).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(nestedStack).toHaveCount(0);
      await expect(refBrowser).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(refBrowser).toHaveCount(0);
      await graphPosition.click();
      await expect(page.getByRole("region", { name: "Stack", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Open stack view" }).click();
      await expect(page.getByRole("region", { name: "Stack", exact: true })).toBeVisible();
      const member = page.getByRole("complementary", { name: "Stack member" });
      await expect(member).toBeVisible();
      await expect(member.getByRole("button", { name: "Open PR #402" })).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-view.png") });
      await page.getByRole("button", { name: "Back to worktree" }).click();
      await expect(graphPosition).toBeVisible();
      await graphPosition.click();
      await expect(page.getByRole("region", { name: "Stack", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Open stack view" }).click();
      await page.evaluate(() => (window as unknown as { showOperations(): void }).showOperations());
      await page.getByRole("button", { name: "Restack", exact: true }).click();
      await expect(page.getByRole("complementary", { name: "Stack operation plan" })).toBeVisible();
      await expect(page.getByText("1 patch preserved")).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-plan.png"), animations: "disabled" });
      await page.getByRole("button", { name: "Run locally" }).click();
      await expect(page.getByRole("complementary", { name: "Proof ledger" })).toBeVisible();
      await expect(page.getByText("2 patches preserved")).toBeVisible();
      await expect(page.locator(".stack-group__caption").getByText("Restack")).toHaveCount(0);
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      if (shots) await page.screenshot({ path: join(shots, "stack-after-proof.png"), animations: "disabled" });
      await undo.click();
      await expect(page.locator(".stack-group__caption").getByText("Restack")).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Proof ledger" })).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
