import { readFileSync, writeFileSync } from "node:fs";
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

test("reviews, accepts, and continues a real merge conflict", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoWithMergeConflict("conflicted-merge");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "conflicted-merge");

  await expect(window.getByText("1 unresolved path", { exact: true })).toBeVisible({
    timeout: 20_000
  });
  await expect(window.getByRole("tab", { name: "Theirs" })).toBeVisible();
  await window.getByRole("tab", { name: "Theirs" }).click();
  await expect(window.locator(".conflict-preview__text")).toContainText(
    "feature version"
  );

  await window
    .getByRole("button", { name: "Accept theirs", exact: true })
    .click();
  await expect(window.locator(".modal--dialog")).toContainText(
    "Other conflicted paths and unrelated changes are untouched"
  );
  await window.locator(".modal--dialog .modal__create").click();

  await expect(window.getByText("Ready to continue", { exact: true })).toBeVisible({
    timeout: 20_000
  });
  await window.getByRole("button", { name: "Continue merge…" }).click();
  await expect(window.locator(".modal--dialog")).toContainText(
    "git merge --continue"
  );
  await window.locator(".modal--dialog .modal__create").click();

  await expect(window.locator(".changes-clean")).toBeVisible({
    timeout: 20_000
  });
  expect(readFileSync(join(repo.path, "conflict.txt"), "utf8")).toBe(
    "feature version\n"
  );
  expect(sandbox.git(repo.path, "status", "--porcelain")).toBe("");
  expect(sandbox.git(repo.path, "rev-list", "--parents", "-n", "1", "HEAD").split(" "))
    .toHaveLength(3);
});

test("refreshes after a conflict is resolved outside PwrGit", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoWithMergeConflict("external-resolution");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "external-resolution");
  await expect(window.getByText("1 unresolved path", { exact: true })).toBeVisible({
    timeout: 20_000
  });

  writeFileSync(join(repo.path, "conflict.txt"), "resolved in editor\n");
  sandbox.git(repo.path, "add", "conflict.txt");
  await window.getByRole("button", { name: "Refresh", exact: true }).click();

  await expect(window.getByText("Ready to continue", { exact: true })).toBeVisible();
  await window.getByRole("button", { name: "Abort merge…" }).click();
  await window.locator(".modal--dialog .modal__create").click();
  await expect(window.locator(".changes-clean")).toBeVisible({
    timeout: 20_000
  });
});
