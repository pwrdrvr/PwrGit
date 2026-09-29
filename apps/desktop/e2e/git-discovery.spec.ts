import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) { await handle.cleanup(); handle = null; }
  sandbox?.cleanup();
  sandbox = null;
});

test("hook refusal explains the failed commit and offers a one-time bypass", async ({}, testInfo) => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("discovery-hooks");
  writeFileSync(join(repo.path, "README.md"), "# discovery-hooks\nchanged\n");
  sandbox.git(repo.path, "add", "README.md");
  const hook = join(repo.path, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'fixture lint: change needs a test' >&2\nexit 1\n");
  chmodSync(hook, 0o755);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "discovery-hooks");
  await window.locator(".commit-input").fill("feat: revise discovery fixture");
  await expect(window.locator(".commit-actions .commit-btn")).toBeEnabled();
  await window.screenshot({ path: testInfo.outputPath("3a-before-commit.png") });
  await window.locator(".commit-actions .commit-btn").click();
  const failure = window.locator(".discovery-hook-failure");
  await expect(failure).toContainText("pre-commit refused the commit");
  await expect(failure).toContainText("fixture lint: change needs a test");
  await window.screenshot({ path: testInfo.outputPath("3a-after-hook-refusal.png") });
  await failure.getByRole("button", { name: "Commit without hooks…" }).click();
  await expect(window.locator(".modal--dialog")).toContainText("git commit --no-verify");
  await window.locator(".modal--dialog .modal__cancel").click();
  writeFileSync(hook, "#!/bin/sh\necho 'fixture lint passed' >&2\nexit 0\n");
  await failure.getByRole("button", { name: "Retry commit" }).click();
  await expect(window.locator(".discovery-receipt")).toContainText("pre-commit");
  await window.screenshot({ path: testInfo.outputPath("3a-after-hook-passed.png") });
});

test("ignore dialog explains clone scope and the footer attributes hidden files", async ({}, testInfo) => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("discovery-ignore", { worktrees: ["feature"] });
  mkdirSync(join(repo.path, ".local", "shots"), { recursive: true });
  writeFileSync(join(repo.path, ".local", "shots", "after.png"), "fixture image\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "discovery-ignore");
  await expect(window.locator(".discovery-ignored-footer")).toHaveCount(0);
  await window.screenshot({ path: testInfo.outputPath("4a-before-ignore.png") });
  const row = window.locator(".file-row", { hasText: "after.png" });
  await row.click({ button: "right" });
  await window.getByRole("menuitem", { name: "Ignore…" }).click();
  const dialog = window.locator(".discovery-ignore");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".discovery-ignore__destination.is-selected")).toContainText("this clone · 2 worktrees");
  await expect(dialog.locator(".discovery-ignore__preview code").nth(1)).toHaveText("+ /.local/");
  await window.screenshot({ path: testInfo.outputPath("4a-ignore-dialog.png") });
  await dialog.getByRole("button", { name: "Add ignore rule" }).click();
  await expect(window.locator(".discovery-ignored-footer")).toContainText("1 untracked file hidden");
  await window.locator(".discovery-ignored-footer button").hover();
  await expect(window.locator(".discovery-explain")).toContainText(".git/info/exclude");
  await window.screenshot({ path: testInfo.outputPath("4c-after-ignore.png") });
});
