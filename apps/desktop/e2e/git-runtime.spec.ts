import { expect, test } from "@playwright/test";
import { launchApp } from "./fixtures/electron-app";

test("Settings identifies bundled Git and LFS independently of installed versions", async ({}, testInfo) => {
  const handle = await launchApp();
  try {
    const opened = handle.app.waitForEvent("window");
    await handle.app.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu()?.items ?? []) {
        const settings = top.submenu?.items.find((item) => item.label === "Settings…");
        if (settings) { settings.click(); return; }
      }
      throw new Error("Settings menu is missing");
    });
    const page = await opened;
    const section = page.locator('section[aria-label="Git runtime"]');
    await expect(section.getByText("Bundled · In use · Default")).toBeVisible();
    await expect(section).toContainText(/git version \d/);
    await expect(section).toContainText(/git-lfs\/\d/);
    await expect(section.getByText("Installed Git", { exact: true })).toBeVisible();
    await expect(section.getByText("Installed Git LFS", { exact: true })).toBeVisible();
    await expect(section).not.toContainText("Unavailable");

    // Screenshot uses entirely contrived paths and versions; assertions above
    // exercise the real renderer → IPC → bundled runtime probes.
    await section.evaluate((element) => {
      const controls = element.querySelectorAll(".settings-field__control");
      ["git version 2.53.0", "git-lfs/3.7.1", "git version 2.50.1", "git-lfs/3.6.1"].forEach((text, index) => {
        controls[index]!.querySelector("span")!.textContent = text;
      });
      element.querySelector(".settings-field__help")!.textContent = "/Applications/PwrGit.app/Contents/Resources/git/bin/git";
    });
    await section.screenshot({ path: testInfo.outputPath("git-runtime.png") });
  } finally { await handle.cleanup(); }
});
