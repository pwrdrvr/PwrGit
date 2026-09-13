import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandBranchesSection,
  refBranchRow
} from "./fixtures/steps";

/**
 * Switching a checkout that has uncommitted work is a question with three real
 * answers, and PwrGit used to offer one of them against Cancel. These drive the
 * prompt end to end, including the answer that runs no git at all and the
 * failure that has to leave the checkout exactly where it started.
 */
let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

const SETTLE_MS = 20_000;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

const read = (dir: string, file: string): string =>
  readFileSync(join(dir, file), "utf8");

/**
 * A repo on `main` with a `feature` branch that rewrote `shared.txt`, so an
 * edit to that file cannot be carried across and an edit to `quiet.txt` can.
 */
function makeDivergingRepo(box: GitSandbox, name: string): string {
  const repo = box.makeRepo(name);
  box.commit(repo.path, "shared.txt", "base");
  box.commit(repo.path, "quiet.txt", "base");
  box.git(repo.path, "switch", "-c", "feature");
  box.commit(repo.path, "shared.txt", "rewritten on feature");
  box.git(repo.path, "switch", "main");
  return repo.path;
}

async function openPrompt(
  window: AppHandle["window"],
  repoName: string
): Promise<ReturnType<AppHandle["window"]["locator"]>> {
  await expandBranchesSection(window, repoName);
  await refBranchRow(window, "feature").dblclick();
  const prompt = window.locator(".modal--choice");
  await expect(prompt).toBeVisible({ timeout: SETTLE_MS });
  return prompt;
}

test("the prompt names all three answers and the files at stake", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-prompt");
  writeFileSync(join(path, "quiet.txt"), "edited on main\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-prompt");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-prompt");

  await expect(prompt).toContainText("What did you mean to do with them?");
  // The choices name the destination, not the git mechanism that gets there.
  await expect(
    prompt.getByRole("button", { name: /^Bring them to feature/ })
  ).toBeVisible();
  await expect(
    prompt.getByRole("button", { name: /^Commit on main first/ })
  ).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Cancel" })).toBeVisible();
  // The decision rests on which files these are, so the prompt says.
  await expect(prompt.locator(".dialog__facts")).toContainText("quiet.txt");
});

test("bringing the changes along carries them to the new branch", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-carry");
  writeFileSync(join(path, "quiet.txt"), "edited on main\n");
  writeFileSync(join(path, "brand-new.txt"), "untracked\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-carry");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-carry");
  await prompt.getByRole("button", { name: /^Bring them to feature/ }).click();

  await expect(window.locator(".titlebar__branch-name")).toHaveText("feature", {
    timeout: SETTLE_MS
  });
  expect(read(path, "quiet.txt")).toBe("edited on main\n");
  // Untracked work comes too, and the destination's own file is intact.
  expect(read(path, "brand-new.txt")).toBe("untracked\n");
  expect(read(path, "shared.txt")).toBe("rewritten on feature\n");
  expect(box.git(path, "stash", "list")).toBe("");
});

// The answer that runs no git at all: it is a navigation, and its whole job is
// to put the reader where they can do the thing they said they meant.
test("committing first stays put and opens the commit box", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-commit-first");
  writeFileSync(join(path, "quiet.txt"), "edited on main\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-commit-first");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-commit-first");
  await prompt.getByRole("button", { name: /^Commit on main first/ }).click();

  await expect(window.locator(".modal--choice")).toHaveCount(0);
  await expect(window.locator(".titlebar__branch-name")).toHaveText("main");
  await expect(window.locator(".commit-input")).toBeFocused({
    timeout: SETTLE_MS
  });
  expect(read(path, "quiet.txt")).toBe("edited on main\n");
});

test("cancelling changes nothing at all", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-cancel");
  writeFileSync(join(path, "quiet.txt"), "edited on main\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-cancel");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-cancel");
  await prompt.getByRole("button", { name: "Cancel" }).click();

  await expect(window.locator(".modal--choice")).toHaveCount(0);
  await expect(window.locator(".titlebar__branch-name")).toHaveText("main");
  expect(read(path, "quiet.txt")).toBe("edited on main\n");
  await expect(window.locator(".commit-input")).not.toBeFocused();
});

/**
 * The promise the whole design rests on. The work cannot land on `feature`, so
 * the reader ends up back where they started rather than standing on a branch
 * they did not choose, in a tree full of conflict markers.
 */
test("work that cannot be carried leaves the checkout exactly as it was", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-rollback");
  writeFileSync(join(path, "shared.txt"), "edited on main\n");
  writeFileSync(join(path, "brand-new.txt"), "untracked\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-rollback");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-rollback");
  await prompt.getByRole("button", { name: /^Bring them to feature/ }).click();

  // It says what happened in the reader's terms — nothing moved — rather than
  // reporting a failure they would have to inspect the tree to understand.
  await expect(window.locator(".app-toast")).toContainText("stayed put", {
    timeout: SETTLE_MS
  });
  await expect(window.locator(".titlebar__branch-name")).toHaveText("main");
  expect(read(path, "shared.txt")).toBe("edited on main\n");
  expect(read(path, "brand-new.txt")).toBe("untracked\n");
  expect(read(path, "shared.txt")).not.toContain("<<<<<<<");
  // No leftover entry: a stash the reader never made is one they will not think
  // to look for.
  expect(box.git(path, "stash", "list")).toBe("");
});
