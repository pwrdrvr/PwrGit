import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

// Real configurator, contrived bridge data, hidden Electron window. Also
// usable against the pre-change source for a matching before screenshot.
for (const [width, height] of [[1280, 960], [1000, 650]]) {
  test(`maintenance repair configurator fits at ${width}x${height}`, async () => {
    const out = mkdtempSync(join(tmpdir(), "pwrgit-repair-layout-"));
    const html = await buildHarness("maintenance-repair", join(out, "dist"));
    const app = await electron.launch({
      args: ["--disable-accelerated-video-decode", "--disable-accelerated-video-encode",
        join(dirname(fileURLToPath(import.meta.url)), "harness", "electron-main.cjs")],
      env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: String(width), PWRGIT_HARNESS_HEIGHT: String(height) })
    });
    try {
      const page = await app.firstWindow();
      const dialog = page.getByRole("dialog", { name: "Repository maintenance" });
      await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
      const repair = dialog.getByRole("checkbox", { name: "Repair broken worktree links", exact: true });
      if (process.env["PWRGIT_HARNESS_BEFORE"] !== "1") {
        await expect(repair).not.toBeChecked();
        await repair.check();
        await expect(repair).toBeChecked();
        // The configurator scrolls, while Start remains in the fixed footer.
        await dialog.getByRole("checkbox", { name: "Collect garbage", exact: true }).scrollIntoViewIfNeeded();
        await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeInViewport();
        await repair.scrollIntoViewIfNeeded();
      }
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      const shots = process.env["PWRGIT_HARNESS_SHOTS"];
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await dialog.screenshot({ path: join(shots, `maintenance-repair-${width}.png`), animations: "disabled" });
      }
    } finally {
      await app.close();
      rmSync(out, { recursive: true, force: true });
    }
  });
}
