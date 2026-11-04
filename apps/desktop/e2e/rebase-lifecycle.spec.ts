import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

// Real RebaseTab components, fake preload bridge, contrived commits, hidden window.
// PWRGIT_HARNESS_SHOTS writes the same interleaving before and after the fix.
const HERE = dirname(fileURLToPath(import.meta.url));
type Harness = { ready: Promise<void>; finishTidy: () => void; finishApply: () => void; selectTwo: () => void; clearCalls: () => number };
declare global { interface Window { __harness: Harness } }
let app: ElectronApplication;
let out: string;

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

test("cancelled Tidy offers retry and an old Apply leaves the new selection unchecked", async () => {
  test.setTimeout(120_000);
  out = mkdtempSync(join(tmpdir(), "pwrgit-rebase-lifecycle-"));
  const html = await buildHarness("rebase-lifecycle", join(out, "dist"));
  app = await electron.launch({
    args: ["--disable-accelerated-video-decode", "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(HERE, "harness", "electron-main.cjs")],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "960", PWRGIT_HARNESS_HEIGHT: "850" })
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => "__harness" in window);
  await page.evaluate(() => window.__harness.ready);
  const tidy = page.locator('[data-scene="tidy"]');
  const apply = page.locator('[data-scene="apply"]');
  await expect(tidy.locator(".msg-foot")).toContainText("Codex is reading 3 diffs");
  await tidy.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.__harness.finishTidy());
  await apply.getByRole("button", { name: "Check in isolated copy", exact: true }).click();
  await apply.getByRole("button", { name: "Apply rebase", exact: true }).click();
  await page.evaluate(() => window.__harness.selectTwo());
  await expect(apply.locator(".rebase-head__sub")).toHaveText("2 → 2 · feat/csv-export");
  await page.evaluate(() => window.__harness.finishApply());
  // Let React commit the deferred completions and fonts paint before capturing.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots !== undefined && shots !== "") {
    mkdirSync(shots, { recursive: true });
    await page.locator(".harness-grid").screenshot({ path: join(shots, "rebase-lifecycle.png"), animations: "disabled" });
  }
  await expect(tidy.locator(".msg-foot")).toContainText("Cancelled. Nothing changed.");
  await expect(tidy.getByRole("button", { name: "Tidy", exact: true })).toBeEnabled();
  await expect(apply.locator(".rebase-applied")).toHaveCount(0);
  await expect(apply.getByRole("button", { name: "Check in isolated copy", exact: true })).toBeEnabled();
  await expect(apply.getByRole("button", { name: "Apply rebase", exact: true })).toBeDisabled();
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__harness.clearCalls())).toBe(0);
});
