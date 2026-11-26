import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

test("keeps passive submodules collapsed below Changes while auto-expanding active submodule changes", async () => {
  const out = mkdtempSync(join(tmpdir(), "pwrgit-submodule-harness-"));
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  try {
    const html = await buildHarness("submodule-panel", join(out, "dist"));
    const app = await electron.launch({
      args: [
        "--disable-accelerated-video-decode",
        "--disable-accelerated-video-encode",
        join(
          dirname(fileURLToPath(import.meta.url)),
          "harness",
          "electron-main.cjs"
        )
      ],
      env: cleanEnv({
        PWRGIT_HARNESS_HTML: html,
        PWRGIT_HARNESS_WIDTH: "1015",
        PWRGIT_HARNESS_HEIGHT: "665"
      })
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      const passiveDefault = page.locator('[data-scene="passive-default"]');
      const passiveExpanded = page.locator('[data-scene="passive-expanded"]');
      const activeChange = page.locator('[data-scene="active-change"]');

      await expect(
        passiveDefault.getByText("Worktree is clean.")
      ).toBeVisible();
      await expect(
        passiveDefault.locator(".submodule-panel__toggle")
      ).toHaveAttribute("aria-expanded", "false");
      await expect(
        passiveDefault.locator(".submodule-panel__count")
      ).toHaveText("0");
      await expect(
        passiveDefault.locator(".submodule-panel").getByText("2 unconfigured")
      ).toBeVisible();

      // Expand the middle scene and open its first submodule row to inspect
      // leaf-preserving path truncation and deduplicated remedy copy.
      await passiveExpanded.locator(".submodule-panel__toggle").click();
      await expect(
        passiveExpanded.locator(".submodule-row")
      ).toHaveCount(2);
      await passiveExpanded
        .locator(".submodule-row__summary")
        .first()
        .click();
      await expect(
        passiveExpanded.locator(".submodule-row__leaf").first()
      ).toHaveText("codec");
      await expect(
        passiveExpanded.locator(".submodule-row__leaf").nth(1)
      ).toHaveText("runner");
      await expect(
        passiveExpanded.locator(".submodule-row").first().locator(".submodule-issue small")
      ).toHaveCount(1);

      await expect(
        activeChange.getByText("Parent files are clean.")
      ).toBeVisible();
      await expect(
        activeChange.locator(".submodule-panel__toggle")
      ).toHaveAttribute("aria-expanded", "true");
      await expect(
        activeChange.locator(".submodule-panel").getByText("Dirty", { exact: true })
      ).toBeVisible();
      await expect(
        activeChange.locator(".submodule-panel").getByText("Ahead of pin", { exact: true })
      ).toBeVisible();

      // Verify multiple header badges wrap cleanly and never overlap Refresh,
      // and root-level paths without slashes are not capped at 65% width.
      const refreshBox = await activeChange
        .locator(".submodule-panel__refresh")
        .boundingBox();
      expect(refreshBox).not.toBeNull();
      const activeChips = activeChange.locator(
        ".submodule-panel__toggle .submodule-chip"
      );
      await expect(activeChips).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        const chipBox = await activeChips.nth(i).boundingBox();
        expect(chipBox).not.toBeNull();
        expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(
          refreshBox!.x + 1
        );
      }
      const rootLeaf = activeChange
        .locator(".submodule-row")
        .nth(1)
        .locator(".submodule-row__leaf");
      const rootLeafOverflow = await rootLeaf.evaluate(
        (el) => el.scrollWidth > el.clientWidth
      );
      expect(rootLeafOverflow).toBe(false);

      if (shots) {
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, "submodules-after.png") });
      }
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
