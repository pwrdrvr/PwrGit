import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./fixtures/electron-app";

test("GitCafe appears alongside GitHub and GitLab and saves its host switch", async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-cafe-settings-"));
  const fixture = join(directory, "forges.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      hosts: {
        github: {
          installed: true,
          loggedIn: true,
          owners: [],
          repositories: {}
        },
        gitlab: {
          installed: true,
          loggedIn: true,
          owners: [],
          repositories: {}
        },
        gitcafe: {
          installed: true,
          loggedIn: true,
          owners: [],
          repositories: {}
        }
      }
    })
  );
  const handle = await launchApp({ forgeFixturePath: fixture });
  try {
    const userData = await handle.app.evaluate(({ app }) =>
      app.getPath("userData")
    );
    const opened = handle.app.waitForEvent("window");
    await handle.app.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu()?.items ?? []) {
        const settings = top.submenu?.items.find(
          (item) => item.label === "Settings…"
        );
        if (settings !== undefined) {
          settings.click();
          return;
        }
      }
      throw new Error("Settings menu is missing");
    });
    const page = await opened;
    await handle.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().includes("settings"))
          window.setSize(1180, 1100);
      }
    });
    await page.waitForSelector(".settings-screen");
    await page.locator(".settings-nav__button", { hasText: "Forges" }).click();
    const cafeNav = page.locator(".settings-nav__subbutton", { hasText: "GitCafe" });
    await expect(cafeNav).toHaveAttribute("aria-label", "GitCafe: Connected");
    await cafeNav.click();
    await expect(cafeNav).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "GitCafe", exact: true })).toBeFocused();
    for (const product of ["GitHub", "GitLab", "GitCafe"]) {
      await expect(
        page.locator(`section[aria-label='${product}']`).getByLabel(`${product}: Connected`, { exact: true })
      ).toBeVisible();
    }
    await page
      .getByRole("button", { name: "Add GitCafe host…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Add a GitCafe host" });
    await dialog.getByRole("textbox").fill("git.cafe");
    await dialog.getByRole("button", { name: "Add host", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const hostSwitch = page.getByRole("switch", {
      name: "Read GitCafe status from git.cafe"
    });
    await expect(hostSwitch).toHaveAttribute("aria-checked", "true");
    await expect(
      page.locator("code", {
        hasText: "cafe auth login --host https://git.cafe/api"
      })
    ).toBeVisible();
    const name = page.getByRole("textbox", { name: "Name for git.cafe", exact: true });
    await name.fill("Cafe fixture");
    await name.press("Enter");
    await expect.poll(() =>
      JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"))
        .forges.hosts["git.cafe"].label
    ).toBe("Cafe fixture");
    await hostSwitch.click();
    await expect(hostSwitch).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"))
            .forges.hosts["git.cafe"]
      )
      .toMatchObject({ kind: "gitcafe", enabled: false });
    await expect(cafeNav).toHaveAttribute("aria-label", "GitCafe: Off");
    await hostSwitch.click();
    await expect(hostSwitch).toHaveAttribute("aria-checked", "true");
    await expect(cafeNav).toHaveAttribute("aria-label", "GitCafe: Connected");
    const signedOut = JSON.parse(readFileSync(fixture, "utf8"));
    signedOut.hosts.gitcafe.loggedIn = false;
    writeFileSync(fixture, JSON.stringify(signedOut));
    await page.getByRole("button", { name: "Re-check", exact: true }).click();
    await expect(cafeNav).toHaveAttribute("aria-label", "GitCafe: Signed out");
    // Simulate signing in externally, then exercise the real directory refresh.
    const signedIn = JSON.parse(readFileSync(fixture, "utf8"));
    signedIn.hosts.gitcafe.loggedIn = true;
    signedIn.discoveredHosts = [
      { kind: "gitcafe", host: "git.cafe", account: "fixture-user" }
    ];
    writeFileSync(fixture, JSON.stringify(signedIn));
    await page.getByRole("button", { name: "Re-check", exact: true }).click();
    await expect(cafeNav).toHaveAttribute("aria-label", "GitCafe: Connected");
    await expect(
      page.getByText("signed in as fixture-user · added by you", { exact: true })
    ).toBeVisible();
    // Entirely contrived providers and account data, safe for a PR.
    for (const product of ["GitHub", "GitLab"]) {
      const header = page.getByRole("button", { name: product, exact: true });
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "false");
    }
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await page.screenshot({
      path: testInfo.outputPath("gitcafe-settings.png"),
      fullPage: true
    });
    await testInfo.attach("GitCafe settings", {
      path: testInfo.outputPath("gitcafe-settings.png"),
      contentType: "image/png"
    });
  } finally {
    await handle.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});
