import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
  await window.getByRole("button", { name: "↓ Try pull all" }).click();

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
  await window.getByRole("button", { name: "↻ Fetch all" }).click();

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
