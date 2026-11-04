import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
 * Switching a checkout that has uncommitted work asks where that work should
 * go: brought along to the destination, or left behind on the branch it was
 * made on. Neither answer commits. Bringing is a plain switch, and only when
 * Git refuses to overwrite a file does a second question ask about exactly
 * those files. These drive both questions end to end, including the failure
 * that has to leave the checkout exactly where it started, and the offer to
 * put left changes back on return.
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
 * edit to that file cannot be brought across as it is and an edit to
 * `quiet.txt` can.
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

type Window = AppHandle["window"];

async function openPrompt(
  window: Window,
  repoName: string,
  branch = "feature"
): Promise<ReturnType<Window["locator"]>> {
  await expandBranchesSection(window, repoName);
  await refBranchRow(window, branch).dblclick();
  const prompt = window.locator(".modal--choice");
  await expect(prompt).toBeVisible({ timeout: SETTLE_MS });
  return prompt;
}

async function onBranch(window: Window, branch: string): Promise<void> {
  await expect(window.locator(".titlebar__branch-name")).toHaveText(branch, {
    timeout: SETTLE_MS
  });
}

test("the prompt names both destinations and the files at stake", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-prompt");
  writeFileSync(join(path, "quiet.txt"), "edited on main\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-prompt");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-prompt");

  await expect(prompt).toContainText("Where should they go?");
  // The choices name where the work ends up, not the git that gets it there.
  await expect(
    prompt.getByRole("button", { name: /^Bring my changes to feature/ })
  ).toBeVisible();
  await expect(
    prompt.getByRole("button", { name: /^Leave my changes on main/ })
  ).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Cancel" })).toBeVisible();
  // Neither answer commits anything.
  await expect(prompt.getByRole("button", { name: /commit/i })).toHaveCount(0);
  // The decision rests on which files these are, so the prompt says.
  await expect(prompt.locator(".dialog__facts")).toContainText("quiet.txt");
});

test("bringing the changes along is a plain switch, with no stash", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-bring");
  writeFileSync(join(path, "quiet.txt"), "edited on main\n");
  writeFileSync(join(path, "brand-new.txt"), "untracked\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-bring");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-bring");
  await prompt
    .getByRole("button", { name: /^Bring my changes to feature/ })
    .click();

  await onBranch(window, "feature");
  expect(read(path, "quiet.txt")).toBe("edited on main\n");
  // Untracked work comes too, and the destination's own file is intact.
  expect(read(path, "brand-new.txt")).toBe("untracked\n");
  expect(read(path, "shared.txt")).toBe("rewritten on feature\n");
  expect(box.git(path, "stash", "list")).toBe("");
});

// Leaving is the other half of the model: the work waits on its own branch,
// and coming back offers it again.
test("leaving the changes stashes them on main and offers them back there", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-leave");
  writeFileSync(join(path, "shared.txt"), "edited on main\n");
  writeFileSync(join(path, "brand-new.txt"), "untracked\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-leave");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-leave");
  await prompt.getByRole("button", { name: /^Leave my changes on main/ }).click();

  await onBranch(window, "feature");
  expect(read(path, "shared.txt")).toBe("rewritten on feature\n");
  expect(existsSync(join(path, "brand-new.txt"))).toBe(false);
  expect(box.git(path, "status", "--porcelain")).toBe("");
  expect(box.git(path, "stash", "list", "--format=%gs")).toBe(
    "On main: pwrgit: left on main"
  );

  // Back to main: a clean switch, then the offer.
  await refBranchRow(window, "main").dblclick();
  await onBranch(window, "main");
  const offer = window.locator(".app-toast", {
    hasText: "You left 2 changes on main."
  });
  await expect(offer).toBeVisible({ timeout: SETTLE_MS });
  await offer.getByRole("button", { name: "Restore" }).click();

  await expect
    .poll(() => box.git(path, "stash", "list"), { timeout: SETTLE_MS })
    .toBe("");
  expect(read(path, "shared.txt")).toBe("edited on main\n");
  expect(read(path, "brand-new.txt")).toBe("untracked\n");
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
  expect(box.git(path, "stash", "list")).toBe("");
});

/**
 * `feature` has its own `shared.txt`, so Git refuses to bring the edit along.
 * Nothing moved; the second question names the file. Merging it in conflicts,
 * so the reader ends up back where they started rather than standing on a
 * branch they did not choose, in a tree full of conflict markers.
 */
test("a file the destination changed is asked about, and a failed merge moves nothing", async () => {
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
  await prompt
    .getByRole("button", { name: /^Bring my changes to feature/ })
    .click();

  const overwrite = window.locator(".modal--choice", {
    hasText: "feature has its own version of this file"
  });
  await expect(overwrite).toBeVisible({ timeout: SETTLE_MS });
  await expect(overwrite.locator(".dialog__facts")).toContainText("shared.txt");
  await overwrite
    .getByRole("button", { name: /^Merge my changes into feature's/ })
    .click();

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

test("a file the destination changed can be left behind instead", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const path = makeDivergingRepo(box, "dirty-overwrite-leave");
  writeFileSync(join(path, "shared.txt"), "edited on main\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "dirty-overwrite-leave");
  await branchRow(window, "main").first().click();
  const prompt = await openPrompt(window, "dirty-overwrite-leave");
  await prompt
    .getByRole("button", { name: /^Bring my changes to feature/ })
    .click();

  const overwrite = window.locator(".modal--choice", {
    hasText: "feature has its own version of this file"
  });
  await expect(overwrite).toBeVisible({ timeout: SETTLE_MS });
  await overwrite
    .getByRole("button", { name: /^Leave my changes on main/ })
    .click();

  await onBranch(window, "feature");
  expect(read(path, "shared.txt")).toBe("rewritten on feature\n");
  expect(box.git(path, "stash", "list", "--format=%gs")).toBe(
    "On main: pwrgit: left on main"
  );
});
