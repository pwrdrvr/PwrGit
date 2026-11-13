import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, repoGroup } from "./fixtures/steps";

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

// The daily scan had already run, so a repository cloned into a root while
// PwrGit stayed open never reached the sidebar or ⌘K until a window opened a
// day later (pwrdrvr/PwrGit: ~/github/rgit, cloned by an agent).
test("a Fetch run lists a repository cloned into a root while the app runs", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("first");
  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "first");

  sandbox.makeRepo("rgit");
  await expect(repoGroup(window, "rgit")).toHaveCount(0);
  // Every Fetch/Pull run, yours or the timer's, looks at the folders first.
  const toolbar = window.getByRole("group", { name: "Repositories", exact: true });
  await toolbar.getByRole("button", { name: "Fetch all repos" }).click();
  await expect(repoGroup(window, "rgit")).toBeVisible();
});

test("Add ▾ → Rescan folders finds a new repository and says so", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("first");
  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "first");

  sandbox.makeRepo("rgit");
  const toolbar = window.getByRole("group", { name: "Repositories", exact: true });
  await toolbar.getByRole("button", { name: "Add repositories" }).click();
  await window.getByRole("menuitem", { name: "Rescan folders" }).click();

  const toast = window.locator(".app-toast");
  await expect(toast).toContainText("New repository");
  await expect(toast).toContainText("rgit");
  await expect(repoGroup(window, "rgit")).toBeVisible();

  await toolbar.getByRole("button", { name: "Add repositories" }).click();
  await window.getByRole("menuitem", { name: "Rescan folders" }).click();
  await expect(window.locator(".app-toast")).toContainText("No new repositories");
});
