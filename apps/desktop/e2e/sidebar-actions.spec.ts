import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

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

test("clone action stays visible above a long scrolling repo list", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("clone-action-fixture");
  for (let index = 0; index < 20; index += 1) {
    repo.addWorktree(`padding/worktree-${String(index).padStart(2, "0")}`);
  }

  handle = await launchApp();
  const { app, window } = handle;
  const clone = window.locator(".clone-repo");

  // The capability is discoverable even before setup, with its prerequisite
  // made explicit rather than hiding the action entirely.
  await expect(clone).toBeVisible();
  await expect(clone).toBeDisabled();
  await expect(clone).toHaveAttribute(
    "title",
    "Add a repo folder before cloning"
  );
  await expect(
    window.getByText("Add a repo folder to enable clone and fork.")
  ).toBeVisible();
  await expect(clone).toBeInViewport();

  await addRootAndExpand(window, handle, sandbox, repo.name);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1360, 620);
  });
  await expect
    .poll(() =>
      window.evaluate(() => document.documentElement.clientHeight)
    )
    .toBeLessThanOrEqual(620);

  await expect(clone).toBeEnabled();
  await expect(clone).toBeInViewport();
  const beforeScroll = await clone.boundingBox();
  await window.locator(".sidebar__list").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(clone).toBeInViewport();
  const afterScroll = await clone.boundingBox();
  expect(afterScroll?.y).toBe(beforeScroll?.y);

  await clone.click();
  await expect(
    window.getByRole("dialog", { name: "Clone a repository" })
  ).toBeVisible();
});
