import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

test("switch the checked-out branch from the header switcher", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("switchrepo");
  // A branch that exists but isn't checked out anywhere — switchable.
  repo.createBranch("develop");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "switchrepo");

  // Select the primary worktree (on main) so its header shows.
  await branchRow(window, "main").first().click();
  const branchName = window.locator(".wt-header__branch-name");
  await expect(branchName).toHaveText("main", { timeout: 20_000 });

  // Open the switcher and pick develop.
  await window.locator(".wt-header__branch--switch").click();
  await expect(window.locator(".overlay-panel")).toBeVisible();
  await window
    .locator(".branch-item__name", { hasText: "develop" })
    .click();

  // The header now reflects the new checkout, and the overlay is gone.
  await expect(branchName).toHaveText("develop", { timeout: 20_000 });
  await expect(window.locator(".overlay-panel")).toBeHidden();
});
