import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

const GRAPH_MS = 20_000;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

/** Right-click the named commit and open the branch dialog from its menu. */
async function openBranchDialog(
  window: AppHandle["window"],
  subject: string
): Promise<void> {
  const row = window.locator(".graph-row", { hasText: subject });
  await expect(row).toBeVisible({ timeout: GRAPH_MS });
  await row.click({ button: "right" });
  await window
    .getByRole("menu", { name: "Commit actions" })
    .getByRole("menuitem", { name: "Branch from this commit…" })
    .click();
  await expect(window.locator(".branch-from")).toBeVisible();
}

test("branches from an older commit without touching any working copy", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("branchpoint");
  sandbox.commit(repo.path, "one.txt", "the commit to branch from");
  sandbox.commit(repo.path, "two.txt", "later work on main");
  const target = sandbox.git(repo.path, "rev-parse", "HEAD~1");

  handle = await launchApp({ worktreeRoot: sandbox.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "branchpoint");
  await branchRow(window, "main").first().click();

  await openBranchDialog(window, "the commit to branch from");

  // The name is suggested from the subject, and "Don't check out" is the
  // out-of-the-box choice.
  const name = window.locator(".branch-from .modal__input");
  await expect(name).toHaveValue("the-commit-to-branch-from");
  await expect(window.locator('.branch-from input[value="none"]')).toBeChecked();

  await name.fill("spike/from-commit");
  await window.locator(".branch-from .modal__create").click();
  await expect(window.locator(".branch-from")).toBeHidden();

  // The ref exists at that exact commit, and nothing was checked out for it.
  expect(sandbox.git(repo.path, "rev-parse", "spike/from-commit")).toBe(target);
  expect(sandbox.git(repo.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(existsSync(join(sandbox.worktreeRoot, "branchpoint"))).toBe(false);
});

test("checks a branch created from a commit out into a new worktree", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("branchout");
  sandbox.commit(repo.path, "one.txt", "worth revisiting");
  sandbox.commit(repo.path, "two.txt", "later work on main");
  const target = sandbox.git(repo.path, "rev-parse", "HEAD~1");

  handle = await launchApp({ worktreeRoot: sandbox.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "branchout");
  await branchRow(window, "main").first().click();

  await openBranchDialog(window, "worth revisiting");
  await window.locator(".branch-from .modal__input").fill("fix/revisit");
  await window.locator('.branch-from input[value="new-worktree"]').check();

  // The dialog shows the directory it is about to create, resolved by the main
  // process rather than guessed here.
  const expectedPath = join(sandbox.worktreeRoot, "branchout", "fix-revisit");
  await expect(window.locator(".branch-from__choice.is-selected")).toContainText(
    expectedPath
  );
  await expect(window.locator(".branch-from .modal__create")).toHaveText(
    "Create branch & worktree"
  );

  await window.locator(".branch-from .modal__create").click();
  await expect(window.locator(".branch-from")).toBeHidden();

  await expect(branchRow(window, "fix/revisit")).toBeVisible({
    timeout: GRAPH_MS
  });
  expect(existsSync(expectedPath)).toBe(true);
  expect(sandbox.git(expectedPath, "rev-parse", "HEAD")).toBe(target);
  // PwrGit selects what it just created, rather than leaving you on main.
  await expect(window.locator(".wt-row.is-selected")).toContainText(
    "fix/revisit",
    { timeout: GRAPH_MS }
  );
});

test("closes rather than act on a worktree switched under it", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("switcheroo");
  sandbox.commit(repo.path, "one.txt", "the branch point");
  repo.addWorktree("feature/elsewhere");

  handle = await launchApp({ worktreeRoot: sandbox.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "switcheroo");
  await branchRow(window, "main").first().click();
  await openBranchDialog(window, "the branch point");

  // ⌘F reaches past the dialog's backdrop, so the selection can move out from
  // under it. The dialog's commit, dirty check and branch list all belong to
  // the worktree it was opened from, so it must not survive the switch.
  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("feature/elsewhere");
  await expect(window.locator(".overlay-result").first()).toContainText(
    "feature/elsewhere"
  );
  await window.keyboard.press("Enter");

  await expect(window.locator(".wt-row.is-selected")).toContainText(
    "feature/elsewhere",
    { timeout: GRAPH_MS }
  );
  await expect(window.locator(".branch-from")).toBeHidden();
});

test("checks out in place only while the worktree is clean", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("branchhere");
  sandbox.commit(repo.path, "one.txt", "the branch point");
  sandbox.commit(repo.path, "two.txt", "later work on main");
  const target = sandbox.git(repo.path, "rev-parse", "HEAD~1");
  const dirty = repo.addWorktree("feature/dirty", { dirty: true });

  handle = await launchApp({ worktreeRoot: sandbox.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "branchhere");

  // Uncommitted work makes an in-place checkout unavailable, with the reason
  // shown where the choice would be.
  await branchRow(window, "feature/dirty").first().click();
  await openBranchDialog(window, "the branch point");
  const here = window.locator('.branch-from input[value="here"]');
  await expect(here).toBeDisabled();
  await expect(window.locator(".branch-from__targets")).toContainText(
    "feature/dirty has uncommitted changes"
  );
  await window.locator(".branch-from .modal__cancel").click();
  expect(sandbox.git(dirty, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    "feature/dirty"
  );

  // The clean primary worktree offers it, and takes the checkout.
  await branchRow(window, "main").first().click();
  await openBranchDialog(window, "the branch point");
  await window.locator(".branch-from .modal__input").fill("fix/in-place");
  await window.locator('.branch-from input[value="here"]').check();
  await window.locator(".branch-from .modal__create").click();
  await expect(window.locator(".branch-from")).toBeHidden();

  await expect(branchRow(window, "fix/in-place")).toBeVisible({
    timeout: GRAPH_MS
  });
  expect(sandbox.git(repo.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    "fix/in-place"
  );
  expect(sandbox.git(repo.path, "rev-parse", "HEAD")).toBe(target);
});
