import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

// The real RebaseTab's Squash message box, fake preload bridge, contrived
// commits, hidden window. Cancel on an agent draft is terminal: the footer
// says so at once, and a draft main sends afterwards never fills the box.
// PWRGIT_HARNESS_SHOTS writes the same interleaving before and after the fix.
const HERE = dirname(fileURLToPath(import.meta.url));
type Harness = { ready: Promise<void>; answer: (scene: string) => void; drafts: () => number; cancels: () => number };
let app: ElectronApplication;
let out: string;

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

test("Cancel ends a message draft, and a draft that lands afterwards is dropped", async () => {
  test.setTimeout(120_000);
  out = mkdtempSync(join(tmpdir(), "pwrgit-message-draft-cancel-"));
  const html = await buildHarness("message-draft-cancel", join(out, "dist"));
  app = await electron.launch({
    args: ["--disable-accelerated-video-decode", "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(HERE, "harness", "electron-main.cjs")],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "960", PWRGIT_HARNESS_HEIGHT: "700" })
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => "__harness" in window);
  await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
  const cancelled = page.locator('[data-scene="cancelled"]');
  const late = page.locator('[data-scene="late"]');
  for (const scene of [cancelled, late]) {
    await expect(scene.locator(".msg-foot")).toContainText("Codex is reading 3 diffs");
    await scene.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.answer("demo-late"));
  // Let React commit the late answer and fonts paint before capturing.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots !== undefined && shots !== "") {
    mkdirSync(shots, { recursive: true });
    await page.locator(".harness-grid").screenshot({ path: join(shots, "message-draft-cancel.png"), animations: "disabled" });
  }
  expect(await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.drafts())).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.cancels())).toBe(2);
  for (const scene of [cancelled, late]) {
    await expect(scene.locator(".msg-foot")).toContainText("Draft cancelled");
    await expect(scene.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(scene.getByRole("button", { name: "Draft", exact: true })).toBeEnabled();
    await expect(scene.getByRole("textbox", { name: "Commit message" })).not.toHaveValue(/ship CSV export/);
  }
});
