import { expect, test } from "@playwright/test";
import { launchApp } from "./fixtures/electron-app";

test("Settings runs bundled Git and LFS by default and lists the Gits it could run instead", async ({}, testInfo) => {
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
    // The in-use rows show the version the probe parsed out of the real
    // `git --version` / `git lfs version`, and LFS keeps its build tail beneath.
    const values = section.locator(".settings-field__value");
    await expect(values.nth(0)).toHaveText(/^\d+\.\d+/);
    await expect(values.nth(1)).toHaveText(/^\d+\.\d+/);
    // The executable path — `git` on POSIX, `git.exe` on Windows.
    await expect(
      section.locator(".settings-field__detail").filter({ hasText: /[\\/]git(\.exe)?$/ })
    ).toHaveCount(1);
    await expect(section).toContainText(/git-lfs\/\d/);
    // The bundle is always the first install, and the one in use.
    const bundled = section.locator(".settings-ai-install").first();
    await expect(bundled.locator(".settings-ai-install__meta")).toHaveText(/^Bundled · \d+\.\d+.* · LFS \d/);
    await expect(bundled.locator(".settings-card__chip")).toHaveText("Using");
    await expect(section.getByRole("textbox", { name: "Custom Git path" })).toHaveValue("");
    await expect(section.locator(".settings-field__error")).toHaveCount(0);
    await expect(section.getByRole("alert")).toHaveCount(0);

    // Screenshot uses entirely contrived paths and versions; assertions above
    // exercise the real renderer → IPC → bundled runtime probes.
    await section.evaluate((element) => {
      const values = ["2.53.0", "3.7.1"];
      element.querySelectorAll(".settings-field__value:not(.settings-field__value--absent)").forEach((value, index) => {
        if (index < values.length) value.textContent = values[index] ?? value.textContent;
      });
      element.querySelectorAll(".settings-field__detail").forEach((detail) => {
        const text = detail.textContent ?? "";
        detail.textContent = text.startsWith("git-lfs/")
          ? "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24.0)"
          : text.endsWith("git-credential-osxkeychain")
            ? "/opt/homebrew/Cellar/git/2.50.1/libexec/git-core/git-credential-osxkeychain"
            : "/Applications/PwrGit.app/Contents/Resources/git/bin/git";
      });
      const rows = [
        ["/Applications/PwrGit.app/Contents/Resources/git/bin/git", "Bundled · 2.53.0 · LFS 3.7.1"],
        ["/opt/homebrew/bin/git", "Homebrew · 2.50.1 · LFS 3.7.0"],
        ["/Library/Developer/CommandLineTools/usr/bin/git", "Apple · 2.39.5"]
      ];
      element.querySelectorAll(".settings-ai-install").forEach((row, index) => {
        const [path, meta] = rows[index] ?? [];
        if (path === undefined) { row.remove(); return; }
        const pathNode = row.querySelector(".settings-ai-install__path");
        const metaNode = row.querySelector(".settings-ai-install__meta");
        if (pathNode !== null) pathNode.textContent = path;
        if (metaNode !== null) metaNode.textContent = meta ?? "";
      });
    });
    await section.screenshot({ path: testInfo.outputPath("git-runtime.png") });
  } finally { await handle.cleanup(); }
});
