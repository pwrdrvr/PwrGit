import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";

// One window per profile: creating/picking a profile opens (or focuses) its
// own window — it never repoints the window you're in.
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

test("creating a profile opens its own window with repos from all roots", async () => {
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

  // Creating opens a NEW window bound to the new profile.
  const windowPromise = handle.app.waitForEvent("window");
  await window.locator(".modal--profile .modal__create").click();
  const giphyWindow = await windowPromise;
  await giphyWindow.waitForSelector("#root");

  await expect(giphyWindow.locator(".profile-chip__name")).toHaveText("Giphy", {
    timeout: 20_000
  });
  // The original window keeps ITS profile — no in-window switching. (The
  // seed is named "Personal" now — a workspace label, not the git identity.)
  await expect(window.locator(".profile-chip__name")).toHaveText("Personal");

  // The new window lists repos from BOTH roots.
  await giphyWindow.locator(".lens-chip", { hasText: "All" }).click();
  await expect(
    giphyWindow.locator(".repo-row__name", { hasText: "giphy-svc" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    giphyWindow.locator(".repo-row__name", { hasText: "pwr-svc" })
  ).toBeVisible();

  // Group-by-folder splits them into one section per root.
  await giphyWindow.locator(".group-toggle").click();
  await expect(giphyWindow.locator(".repo-group")).toHaveCount(2);

  // Picking the profile again anywhere focuses the existing window — never a
  // third one. (Drive it from the original window's menu.)
  await window.locator(".profile-chip").click();
  await window
    .locator(".profile-menu__item", { hasText: "Giphy" })
    .click();
  await window.waitForTimeout(600);
  expect(handle.app.windows().length).toBe(2);
});

test("profile menu closes on outside click and Escape", async () => {
  handle = await launchApp();
  const { window } = handle;

  await window.locator(".profile-chip").click();
  await expect(window.locator(".profile-menu")).toBeVisible();

  // Click anywhere else — the full-viewport backdrop is what an outside click
  // lands on now, and it closes the menu.
  await window
    .locator(".profile-menu__backdrop")
    .click({ position: { x: 600, y: 400 } });
  await expect(window.locator(".profile-menu")).toHaveCount(0);

  // Escape closes it too.
  await window.locator(".profile-chip").click();
  await expect(window.locator(".profile-menu")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.locator(".profile-menu")).toHaveCount(0);
});
