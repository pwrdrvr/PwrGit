import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./fixtures/electron-app";

test("Gerrit offers public reads and persists a separate review endpoint", async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-gerrit-settings-"));
  const fixture = join(directory, "forges.json");
  writeFileSync(fixture, JSON.stringify({ hosts: { gerrit: {
    installed: true, loggedIn: false, owners: [], repositories: {}
  } } }));
  const handle = await launchApp({ forgeFixturePath: fixture });
  try {
    const userData = await handle.app.evaluate(({ app }) => app.getPath("userData"));
    const opened = handle.app.waitForEvent("window");
    await handle.app.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu()?.items ?? []) {
        const settings = top.submenu?.items.find((item) => item.label === "Settings…");
        if (settings !== undefined) { settings.click(); return; }
      }
      throw new Error("Settings menu is missing");
    });
    const page = await opened;
    const nativeWindow = await handle.app.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1180, 1100));
    await page.locator(".settings-nav__button", { hasText: "Forges" }).click();
    const nav = page.locator(".settings-nav__subbutton", { hasText: "Gerrit" });
    await expect(nav).toHaveAttribute("aria-label", "Gerrit: Public access");
    await nav.click();
    await page.getByRole("button", { name: "Add Gerrit host…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a Gerrit host" });
    await dialog.getByRole("textbox").fill("git.example.test");
    await dialog.getByRole("button", { name: "Add host", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const endpoint = page.getByRole("textbox", { name: "Review URL for git.example.test", exact: true });
    await endpoint.fill("https://review.example.test/r/");
    await endpoint.press("Enter");
    const readHost = () => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).forges.hosts["git.example.test"];
    await expect.poll(readHost).toMatchObject({ kind: "gerrit", reviewUrl: "https://review.example.test/r" });
    const hostSwitch = page.getByRole("switch", { name: "Read Gerrit status from git.example.test" });
    await hostSwitch.click();
    await expect.poll(readHost).toMatchObject({ enabled: false });
    await hostSwitch.click();
    await expect.poll(readHost).toMatchObject({ enabled: true });
    const section = page.locator("section[aria-label='Gerrit']");
    await expect(section).not.toContainText("auth login");
    await expect(section).toContainText("Public access");
    await section.screenshot({ path: testInfo.outputPath("gerrit-settings.png") });
    await testInfo.attach("Gerrit settings (synthetic host)", { path: testInfo.outputPath("gerrit-settings.png"), contentType: "image/png" });
  } finally {
    await handle.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});
