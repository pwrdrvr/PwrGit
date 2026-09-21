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
    await expect(section.locator(".settings-card__chip")).toHaveText("Bundled");
    // The bundled rows show the version the probe parsed out of the real
    // `git --version` / `git lfs version`, and LFS keeps its build tail beneath.
    const values = section.locator(".settings-field__value");
    await expect(values.nth(0)).toHaveText(/^\d+\.\d+/);
    await expect(values.nth(1)).toHaveText(/^\d+\.\d+/);
    // The executable path — `git` on POSIX, `git.exe` on Windows.
    await expect(
      section.locator(".settings-field__detail").filter({ hasText: /[\\/]git(\.exe)?$/ })
    ).toHaveCount(1);
    await expect(section).toContainText(/git-lfs\/\d/);
    await expect(section.getByText("Installed Git", { exact: true })).toBeVisible();
    await expect(section.getByText("Installed Git LFS", { exact: true })).toBeVisible();
    await expect(section.locator(".settings-field__error")).toHaveCount(0);
    await expect(section.getByRole("alert")).toHaveCount(0);

    // Screenshot uses entirely contrived paths and versions; assertions above
    // exercise the real renderer → IPC → bundled runtime probes.
    await section.evaluate((element) => {
      const versions = ["2.53.0", "3.7.1", "2.50.1", "3.6.1"];
      const tails = [
        "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)",
        "git-lfs/3.6.1 (GitHub; darwin arm64; go 1.23.4)"
      ];
      element.querySelectorAll(".settings-field__control").forEach((control, index) => {
        const value = control.querySelector(".settings-field__value");
        if (value !== null && !value.classList.contains("settings-field__value--absent")) {
          value.textContent = versions[index] ?? value.textContent;
        }
        control.querySelectorAll(".settings-field__detail").forEach((detail) => {
          detail.textContent = detail.textContent?.startsWith("git-lfs/")
            ? (tails.shift() ?? detail.textContent)
            : "/Applications/PwrGit.app/Contents/Resources/git/bin/git";
        });
      });
    });
    await section.screenshot({ path: testInfo.outputPath("git-runtime.png") });
  } finally { await handle.cleanup(); }
});
