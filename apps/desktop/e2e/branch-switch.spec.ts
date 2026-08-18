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

/**
 * The graph draws the branches; switching to one used to be possible only from
 * the header switcher, even with the branch's chip right there on the row.
 */
test("switches to a branch from the commit that tips it", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("graphswitch");
  sandbox.commit(repo.path, "base.txt", "shared base");
  // A branch with a commit of its own, checked out nowhere — drawn as its own
  // lane, and switchable.
  sandbox.git(repo.path, "switch", "-c", "feature/graph");
  sandbox.commit(repo.path, "feature.txt", "work only on the feature branch");
  sandbox.git(repo.path, "switch", "main");
  sandbox.commit(repo.path, "later.txt", "later work on main");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "graphswitch");
  await branchRow(window, "main").first().click();
  const branchName = window.locator(".titlebar__branch-name");
  await expect(branchName).toHaveText("main", { timeout: GRAPH_MS });

  const row = window.locator(".graph-row", {
    hasText: "work only on the feature branch"
  });
  await expect(row).toBeVisible({ timeout: GRAPH_MS });
  await row.click({ button: "right" });
  await window
    .getByRole("menu", { name: "Commit actions" })
    .getByRole("menuitem", { name: "Switch to feature/graph" })
    .click();

  await expect(branchName).toHaveText("feature/graph", { timeout: GRAPH_MS });
  expect(sandbox.git(repo.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    "feature/graph"
  );
});

test("a tip chip opens the branch's own menu, not the commit's", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("chipmenu");
  sandbox.commit(repo.path, "base.txt", "shared base");
  sandbox.git(repo.path, "switch", "-c", "feature/chip");
  sandbox.commit(repo.path, "feature.txt", "the branch tip");
  sandbox.git(repo.path, "switch", "main");
  sandbox.commit(repo.path, "later.txt", "later work on main");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "chipmenu");
  await branchRow(window, "main").first().click();
  await expect(window.locator(".titlebar__branch-name")).toHaveText("main", {
    timeout: GRAPH_MS
  });

  const chip = window.getByRole("button", {
    name: "Actions for branch feature/chip"
  });
  await expect(chip).toBeVisible({ timeout: GRAPH_MS });
  await chip.click({ button: "right" });

  const menu = window.getByRole("menu", { name: "feature/chip actions" });
  await expect(menu).toBeVisible();
  await expect(window.getByRole("menu", { name: "Commit actions" })).toBeHidden();
  await expect(menu.getByRole("menuitem", { name: "Copy branch name" })).toBeVisible();

  // A left click is the same gesture on a chip — and must not open the commit.
  await window.keyboard.press("Escape");
  await chip.click();
  await expect(menu).toBeVisible();
});
