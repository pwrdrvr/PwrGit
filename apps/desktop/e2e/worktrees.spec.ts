import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";

// Real Electron app + real git repos in a throwaway dir, driven through the UI.
// Sequential (workers: 1) so the module-level handles are safe.
let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  if (sandbox !== null) {
    sandbox.cleanup();
    sandbox = null;
  }
});

/** Add the sandbox as a repo folder (via the stubbed picker), switch to the All
    lens so nothing is filtered out, then wait for `repoName` and expand it. */
async function addRootAndExpand(
  window: Page,
  app: AppHandle,
  box: GitSandbox,
  repoName: string
): Promise<void> {
  await app.setPickDirectory(box.reposDir);
  await window.getByRole("button", { name: /Add repo folder/i }).click();
  await window.locator(".lens-chip", { hasText: "All" }).click();
  const repoRow = window.locator(".repo-row__name", { hasText: repoName });
  await expect(repoRow).toBeVisible({ timeout: 20_000 });
  await repoRow.click();
}

const branchRow = (window: Page, branch: string): Locator =>
  window.locator(".wt-row").filter({ hasText: branch });

test("scans a folder and lists a repo with its worktrees", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/login", "chore/cleanup"] });
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "alpha");

  await expect(branchRow(window, "main")).toBeVisible();
  await expect(branchRow(window, "feature/login")).toBeVisible();
  await expect(branchRow(window, "chore/cleanup")).toBeVisible();
});

test("creates a worktree through the New worktree modal", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("beta");
  handle = await launchApp({ worktreeRoot: sandbox.worktreeRoot });
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "beta");

  await window.getByRole("button", { name: /New worktree/i }).click();
  await window.locator(".modal__input").fill("feature/e2e-created");
  await window.locator(".modal__create").click();

  await expect(branchRow(window, "feature/e2e-created")).toBeVisible({
    timeout: 20_000
  });
  // The app created it under the configured worktreeRoot (branch slashes → '-').
  expect(
    existsSync(join(sandbox.worktreeRoot, "beta", "feature-e2e-created"))
  ).toBe(true);
});

test("batch-removes worktrees (including a dirty one) via multi-select", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("gamma");
  const one = repo.addWorktree("wt/one");
  const two = repo.addWorktree("wt/two");
  const dirty = repo.addWorktree("wt/dirty", { dirty: true });
  handle = await launchApp();
  const { window } = handle;
  // Accept the confirms: the up-front "remove 3?" and the "1 is dirty, force?".
  window.on("dialog", (d) => void d.accept());

  await addRootAndExpand(window, handle, sandbox, "gamma");

  // Plain-click the first, ⌘-click the other two → 3 selected.
  await branchRow(window, "wt/one").locator(".wt-row__branch").click();
  await branchRow(window, "wt/two")
    .locator(".wt-row__branch")
    .click({ modifiers: ["Meta"] });
  await branchRow(window, "wt/dirty")
    .locator(".wt-row__branch")
    .click({ modifiers: ["Meta"] });
  await expect(window.locator(".wt-selbar__count")).toHaveText("3 selected");

  await window.locator(".wt-selbar__btn--danger").click();

  await expect(branchRow(window, "wt/one")).toHaveCount(0, { timeout: 20_000 });
  await expect(branchRow(window, "wt/two")).toHaveCount(0);
  await expect(branchRow(window, "wt/dirty")).toHaveCount(0);
  await expect(branchRow(window, "main")).toBeVisible();

  // ...and they're gone from disk too.
  expect(existsSync(one)).toBe(false);
  expect(existsSync(two)).toBe(false);
  expect(existsSync(dirty)).toBe(false);
});
