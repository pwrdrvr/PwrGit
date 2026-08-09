import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow } from "./fixtures/steps";

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

test("switch the checked-out branch from the header switcher", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("switchrepo");
  // A branch that exists but isn't checked out anywhere — switchable.
  repo.createBranch("develop");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "switchrepo");

  // Select the primary worktree (on main) so its header shows.
  await branchRow(window, "main").first().click();
  const branchName = window.locator(".titlebar__branch-name");
  await expect(branchName).toHaveText("main", { timeout: 20_000 });

  // Open the switcher and pick develop.
  await window.locator(".titlebar__branch").click();
  await expect(window.locator(".overlay-panel")).toBeVisible();
  await window
    .locator(".branch-item__name", { hasText: "develop" })
    .click();

  // The header now reflects the new checkout, and the overlay is gone.
  await expect(branchName).toHaveText("develop", { timeout: 20_000 });
  await expect(window.locator(".overlay-panel")).toBeHidden();
});

// Reproduces the "stuck on an agent's branch" report: a terminal/agent switches
// the checkout behind the app's back, the header keeps the stale label, and
// clicking the (live) current branch in the switcher used to no-op instead of
// reconciling the app with reality.
test("an externally switched checkout reconciles from the switcher", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("agentflip");
  repo.createBranch("feature/agent");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "agentflip");

  await branchRow(window, "main").first().click();
  const branchName = window.locator(".titlebar__branch-name");
  await expect(branchName).toHaveText("main", { timeout: 20_000 });

  // An agent flips the branch outside PwrGit.
  sandbox.git(repo.path, "switch", "feature/agent");

  // The switcher lists live git truth: feature/agent is current there even
  // while the header may still say main. Picking it must heal the header.
  await window.locator(".titlebar__branch").click();
  await expect(window.locator(".overlay-panel")).toBeVisible();
  const liveCurrent = window.locator(".overlay-result", {
    hasText: "feature/agent"
  });
  await expect(liveCurrent.locator(".branch-item__here")).toBeVisible();
  await liveCurrent.click();

  await expect(branchName).toHaveText("feature/agent", { timeout: 20_000 });
  await expect(window.locator(".overlay-panel")).toBeHidden();
});
