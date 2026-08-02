import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow } from "./fixtures/steps";

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

test("scans a folder and lists a repo with its worktrees", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/login", "chore/cleanup"] });
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "alpha");

  await expect(branchRow(window, "main")).toBeVisible();
  await expect(branchRow(window, "feature/login")).toBeVisible();
  await expect(branchRow(window, "chore/cleanup")).toBeVisible();

  // The primary checkout is marked "local" and sits above the worktrees.
  const firstRow = window.locator(".wt-row").first();
  await expect(firstRow.locator(".wt-row__branch")).toHaveText("main");
  await expect(firstRow.locator(".wt-tag--local")).toBeVisible();

  // Row actions float over the right edge (absolute → reserve no space at rest)
  // and only fade in on hover; the kebab keeps its reserved slot.
  const restRow = branchRow(window, "feature/login");
  const acts = restRow.locator(".wt-row__hoveracts");
  await expect(acts).toHaveCSS("position", "absolute");
  await expect(acts).toHaveCSS("opacity", "0");
  // Re-hover inside the retry: boot-time repo refreshes can re-render the row
  // list right after a hover lands, eating the :hover state.
  await expect(async () => {
    await restRow.hover();
    await expect(acts).toHaveCSS("opacity", "1", { timeout: 500 });
  }).toPass({ timeout: 10_000 });
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

test("reconciles worktrees changed outside PwrGit", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("delta");
  const linked = repo.addWorktree("feature/old");
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "delta");
  await expect(branchRow(window, "feature/old")).toBeVisible();

  const refresh = window.getByRole("button", {
    name: "Refresh worktrees for delta"
  });
  await expect(refresh).toHaveAttribute(
    "title",
    /reconcile with Git to discover new, removed, or changed worktrees/
  );

  // Simulate Codex/PwrAgent changing the repository behind PwrGit's back.
  sandbox.git(linked, "switch", "-c", "feat/messaging-rbac-permissions");
  repo.addWorktree("external/new");

  await refresh.click();
  await expect(
    branchRow(window, "feat/messaging-rbac-permissions")
  ).toBeVisible();
  await expect(branchRow(window, "external/new")).toBeVisible();
  await expect(branchRow(window, "feature/old")).toHaveCount(0);
  await expect(window.locator(".app-toast__message")).toHaveText(
    "1 discovered · 1 updated"
  );

  // Reconciliation updates the command-palette search index in the same
  // transaction, not only the visible sidebar rows.
  await window.getByRole("button", { name: /Jump to repo/i }).click();
  await window.locator(".overlay-search input").fill("rbac");
  await expect(window.locator(".overlay-result__name")).toHaveText(
    "feat/messaging-rbac-permissions"
  );
});

test("batch-removes worktrees (including a dirty one) via multi-select", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("gamma");
  const one = repo.addWorktree("wt/one");
  const two = repo.addWorktree("wt/two");
  const dirty = repo.addWorktree("wt/dirty", { dirty: true });
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "gamma");

  // Plain-click the first, ⌘-click the other two → 3 selected. Click the branch
  // icon (fixed-width, always present) rather than the flex branch label, which
  // can be squeezed to ~0px on a narrow sidebar and become unclickable.
  await branchRow(window, "wt/one").locator(".wt-row__branch-icon").click();
  await branchRow(window, "wt/two")
    .locator(".wt-row__branch-icon")
    .click({ modifiers: ["Meta"] });
  await branchRow(window, "wt/dirty")
    .locator(".wt-row__branch-icon")
    .click({ modifiers: ["Meta"] });
  await expect(window.locator(".wt-selbar__count")).toHaveText("3 selected");

  await window.locator(".wt-selbar__btn--danger").click();
  // Styled in-app confirm, then the "1 is dirty — remove anyway?" confirm.
  await window.locator(".modal--dialog .modal__create").click();
  await window.locator(".modal--dialog .modal__create").click();

  await expect(branchRow(window, "wt/one")).toHaveCount(0, { timeout: 20_000 });
  await expect(branchRow(window, "wt/two")).toHaveCount(0);
  await expect(branchRow(window, "wt/dirty")).toHaveCount(0);
  await expect(branchRow(window, "main")).toBeVisible();

  // ...and they're gone from disk too. Poll: rows disappear per-removal as the
  // sidebar refreshes, so the last deletion can still be in flight (slow
  // Windows CI filesystems surfaced this) when the UI already looks done.
  await expect.poll(() => existsSync(one), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => existsSync(two), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => existsSync(dirty), { timeout: 20_000 }).toBe(false);
});
