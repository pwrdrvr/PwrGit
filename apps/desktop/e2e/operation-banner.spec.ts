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

/**
 * The headline case. A two-step rebase stops on the first conflict; continuing
 * it commits that step and stops on the *next* one, which Git reports with a
 * non-zero exit. The banner has to read that as progress, and the rest of the
 * rail has to stay usable throughout.
 */
test("reports a rebase that advances and stops again as progress", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoWithRebaseConflicts("rebasing");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "rebasing");

  const banner = window.getByTestId("operation-banner");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText("Rebase");
  await expect(banner).toContainText("step 1 of 2");
  await expect(banner).toContainText("1 conflicted path");

  // Continue is unavailable until the conflict is staged.
  const cont = window.getByRole("button", { name: /Continue rebase/ });
  await expect(cont).toBeDisabled();

  // Resolve the way the workflow actually goes: the editor or agent rewrites
  // the file, and the user stages it from PwrGit's own changes list.
  writeFileSync(join(repo.path, "a.txt"), "resolved a\n");
  await window.getByRole("button", { name: "Stage a.txt" }).click();

  await expect(banner).toContainText("No conflicts", { timeout: 20_000 });
  await expect(cont).toBeEnabled();

  await cont.click();
  await window.locator(".modal--dialog .modal__create").click();

  // Git exits non-zero here. It is still progress: step 1 was committed and
  // the sequencer moved on to the conflict in step 2.
  await expect(window.locator(".app-toast")).toContainText("Rebase advanced", {
    timeout: 20_000
  });
  await expect(banner).toContainText("step 2 of 2");
  await expect(banner).toContainText("1 conflicted path");
  expect(sandbox.git(repo.path, "log", "--format=%s", "-1", "HEAD").trim()).toBe(
    "topic a"
  );

  // Resolve the second, and the rebase finishes.
  writeFileSync(join(repo.path, "b.txt"), "resolved b\n");
  await window
    .getByRole("button", { name: "Stage b.txt" })
    .click({ timeout: 20_000 });
  await expect(cont).toBeEnabled({ timeout: 20_000 });
  await cont.click();
  await window.locator(".modal--dialog .modal__create").click();

  await expect(banner).toBeHidden({ timeout: 20_000 });
  expect(sandbox.git(repo.path, "status", "--porcelain").trim()).toBe("");
  expect(readFileSync(join(repo.path, "a.txt"), "utf8")).toBe("resolved a\n");
  expect(readFileSync(join(repo.path, "b.txt"), "utf8")).toBe("resolved b\n");
});

/**
 * The regression that closed the previous attempt at this feature: it replaced
 * the whole rail, so mid-rebase the file list, the commit box, and the rebase
 * tab were all unreachable.
 */
test("keeps the changes list and rebase tab reachable mid-rebase", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepoWithRebaseConflicts("still-usable");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "still-usable");

  await expect(window.getByTestId("operation-banner")).toBeVisible({
    timeout: 20_000
  });

  // The conflicted file is listed by the ordinary changes list, with the
  // status chip it has always had.
  await expect(
    window.locator(".file-row", { hasText: "a.txt" }).first()
  ).toBeVisible();
  await expect(
    window.locator('[aria-label="Conflicted"]').first()
  ).toBeVisible();

  // And the Rebase tab is still there, with the banner riding above it.
  const rebaseTab = window.locator("button.rail-tab", { hasText: "Rebase" });
  await expect(rebaseTab).toBeVisible();
  await rebaseTab.click();
  await expect(window.getByTestId("operation-banner")).toBeVisible();
});

test("aborts a rebase back to the pre-rebase tip", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoWithRebaseConflicts("aborting");
  const before = sandbox
    .git(repo.path, "rev-parse", "refs/heads/topic")
    .trim();

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "aborting");

  const banner = window.getByTestId("operation-banner");
  await expect(banner).toBeVisible({ timeout: 20_000 });

  await window.getByRole("button", { name: /Abort rebase/ }).click();
  await window.locator(".modal--dialog .modal__create").click();

  await expect(banner).toBeHidden({ timeout: 20_000 });
  expect(sandbox.git(repo.path, "rev-parse", "HEAD").trim()).toBe(before);
});
