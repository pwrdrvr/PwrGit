import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

/**
 * A run's first-ever dialog minimises itself after a few seconds, which a
 * slow runner would reach mid-assertion. These specs read the dialog, so
 * they remember it as the reader's choice first.
 */
async function rememberDialogView(window: Page): Promise<void> {
  await window.evaluate(() =>
    window.localStorage.setItem("pwrgit.bulkSyncView", "dialog")
  );
}

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

test("Try pull all fast-forwards safe repos and leaves dirty work untouched", async () => {
  sandbox = createGitSandbox();
  const safe = sandbox.makeRepoBehindRemote("safe", { behindBy: 2 });
  const dirty = sandbox.makeRepoBehindRemote("dirty", { behindBy: 1 });
  writeFileSync(join(dirty.path, "local-wip.txt"), "keep this local work\n");
  const safeUpstream = sandbox.git(safe.path, "rev-parse", "origin/main");
  const dirtyHead = sandbox.git(dirty.path, "rev-parse", "HEAD");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "safe");
  await rememberDialogView(window);
  await window.getByRole("button", { name: "Try pull all", exact: true }).click();

  const dialog = window.getByRole("dialog", {
    name: "Try to pull all safely"
  });
  await expect(dialog).toContainText("PwrGit never stashes");
  await expect(dialog).toContainText("1 worktree updated", { timeout: 20_000 });
  await expect(dialog).toContainText("1 safely skipped");
  await expect(dialog).toContainText("dirty");
  await expect(dialog).toContainText("uncommitted changes");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();

  expect(sandbox.git(safe.path, "rev-parse", "HEAD")).toBe(safeUpstream);
  expect(sandbox.git(dirty.path, "rev-parse", "HEAD")).toBe(dirtyHead);
  expect(sandbox.git(dirty.path, "status", "--porcelain")).toContain(
    "local-wip.txt"
  );
});

test("Fetch all reports one broken remote without stopping other repositories", async () => {
  sandbox = createGitSandbox();
  const partial = sandbox.makeRepoBehindRemote("partial");
  sandbox.git(
    partial.path,
    "remote",
    "add",
    "broken",
    join(sandbox.reposDir, "does-not-exist.git")
  );
  sandbox.makeRepoBehindRemote("healthy");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "partial");
  await rememberDialogView(window);
  await window.getByRole("button", { name: "Fetch all repos", exact: true }).click();

  const dialog = window.getByRole("dialog", {
    name: "Fetch all repositories"
  });
  await expect(dialog).toContainText("2 remotes fetched", { timeout: 20_000 });
  await expect(dialog).toContainText("1 failed");
  await expect(dialog.locator(".bulk-sync__repo.is-partial")).toContainText(
    "partial"
  );
  await expect(dialog).toContainText("broken");
  await expect(dialog).toContainText("Git could not fetch this remote");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
});

test("Fetch all minimises to a toast and expands back to its results", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepoBehindRemote("alpha");
  sandbox.makeRepoBehindRemote("beta");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");
  await rememberDialogView(window);
  await window.getByRole("button", { name: "Fetch all repos", exact: true }).click();

  const dialog = window.getByRole("dialog", { name: "Fetch all repositories" });
  await expect(dialog).toBeVisible();
  // Minimise is offered only while the run is live; a fast run may already
  // have finished, and then Escape closes rather than minimises.
  const minimise = dialog.getByRole("button", { name: "Minimise to a toast" });
  if (await minimise.isVisible()) {
    await minimise.click();
    const toast = window.locator(".bulk-sync-toast");
    await expect(toast).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(toast).toContainText("Fetched 2 repositories", {
      timeout: 20_000
    });
    await toast.getByRole("button", { name: "Show details" }).click();
  }
  await expect(dialog).toContainText("2 remotes fetched", { timeout: 20_000 });
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
});
