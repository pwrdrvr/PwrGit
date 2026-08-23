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
  await expect(window.getByRole("button", { name: "Add folders…" })).toBeDisabled();

  await profileError.getByRole("button", { name: "Try again" }).click();
  await expect(window.locator(".profile-chip__name")).toHaveText("Personal");

  const repoError = window.getByRole("alert").filter({
    hasText: "Repositories couldn’t be loaded"
  });
  await expect(repoError).toBeVisible();
  await repoError.getByRole("button", { name: "Try again" }).click();

  // The successful retry resolves to a real empty list, not another error and
  // not an indefinite scanner. The ordinary first-run action is usable again.
  await expect(window.getByText("No repos yet — add a folder above and PwrGit will scan it.")).toBeVisible();
  await expect(window.getByRole("alert")).toHaveCount(0);
  await expect(window.getByRole("button", { name: "Add folders…" })).toBeEnabled();
});
