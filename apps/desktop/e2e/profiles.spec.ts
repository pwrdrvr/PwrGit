import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";

// Creating a profile with several repo folders at once, driven through the UI.
let boxA: GitSandbox | null = null;
let boxB: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  boxA?.cleanup();
  boxB?.cleanup();
  boxA = null;
  boxB = null;
});

test("creates a profile with multiple root folders in one step", async () => {
  boxA = createGitSandbox();
  boxA.makeRepo("giphy-svc");
  boxB = createGitSandbox();
  boxB.makeRepo("pwr-svc");

  handle = await launchApp();
  const { window } = handle;

  // Open the profile menu → New profile.
  await window.locator(".profile-chip").click();
  await window.locator(".profile-menu__action", { hasText: "New profile" }).click();

  // Fill identity.
  await window.getByPlaceholder("e.g. GIPHY").fill("Giphy");
  await window.getByPlaceholder("you@company.com").fill("harold@giphy.com");

  // Add both folders in one native dialog.
  await handle.setPickDirectories([boxA.reposDir, boxB.reposDir]);
  await window.locator(".modal--profile .rootlist__add").click();
  await expect(window.locator(".modal--profile .rootlist__item")).toHaveCount(2);

  await window.locator(".modal--profile .modal__create").click();

  // The new profile is now active…
  await expect(window.locator(".profile-chip__name")).toHaveText("Giphy");

  // …and its repos from BOTH roots are listed.
  await window.locator(".lens-chip", { hasText: "All" }).click();
  await expect(
    window.locator(".repo-row__name", { hasText: "giphy-svc" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    window.locator(".repo-row__name", { hasText: "pwr-svc" })
  ).toBeVisible();
});
