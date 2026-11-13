import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
});

test("failed boot reads explain the problem and recover without relaunching", async () => {
  handle = await launchApp({
    failReadOnce: ["profile:list", "repo:list"]
  });
  const { window } = handle;

  const profileError = window.getByRole("alert").filter({
    hasText: "Profiles couldn’t be loaded"
  });
  await expect(profileError).toBeVisible();
  // No profile, so no start screen offering to add to one.
  await expect(window.getByTestId("start-screen")).toHaveCount(0);

  await profileError.getByRole("button", { name: "Try again" }).click();
  await expect(window.locator(".profile-chip__name")).toHaveText("Personal");

  const repoError = window.getByRole("alert").filter({
    hasText: "Repositories couldn’t be loaded"
  });
  await expect(repoError).toBeVisible();
  await repoError.getByRole("button", { name: "Try again" }).click();

  // The successful retry resolves to a real empty list, not another error and
  // not an indefinite scanner: the sidebar says so in one line, and the main
  // pane's start screen says what to do next with the add actions usable.
  await expect(window.locator(".sidebar__empty")).toHaveText("No repositories yet.");
  await expect(window.getByRole("alert")).toHaveCount(0);
  await expect(
    window.getByTestId("start-screen").getByRole("button", { name: /^Add folders…/ })
  ).toBeEnabled();
});
