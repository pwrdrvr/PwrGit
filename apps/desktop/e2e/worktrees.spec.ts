import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  collapseWorktrees,
  expandRepoGroup,
  expandWorktrees,
  lensChip,
  repoGroup
} from "./fixtures/steps";

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

test("collapses unpinned Worktrees by default and remembers an explicit choice", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("collapsed-by-default", {
    worktrees: ["feature/one", "feature/two"]
  });
  handle = await launchApp();
  const { window } = handle;

  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  const group = await expandRepoGroup(window, "collapsed-by-default");
  const toggle = window
    .locator(".repo-block", { has: group })
    .locator(".wt-section__toggle");

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(branchRow(window, "feature/one")).toHaveCount(0);

  await expandWorktrees(window, "collapsed-by-default");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // Switching lenses unmounts this unpinned repo. Returning to All creates a
  // fresh row, which must restore the choice rather than fall back to default.
  await lensChip(window, "Pinned").click();
  await expect(repoGroup(window, "collapsed-by-default")).toHaveCount(0);
  await lensChip(window, "All").click();
  const restoredGroup = await expandRepoGroup(window, "collapsed-by-default");
  await expect(
    window
      .locator(".repo-block", { has: restoredGroup })
      .locator(".wt-section__toggle")
  ).toHaveAttribute("aria-expanded", "true");
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

  // The primary checkout is marked "primary" inside the Worktrees group.
  const firstRow = window.locator(".wt-row").first();
  await expect(firstRow.locator(".wt-row__branch")).toHaveText("main");
  await expect(firstRow.locator(".wt-tag--local")).toBeVisible();

  // Row actions float over the right edge (absolute → reserve no space at rest)
  // and only fade in on hover or keyboard focus.
  const restRow = branchRow(window, "feature/login");
  const acts = restRow.locator(".wt-row__hoveracts");
  const menu = restRow.locator(".wt-row__menu");
  await expect(acts).toHaveCSS("position", "absolute");
  await expect(acts).toHaveCSS("opacity", "0");
  await expect(menu).toHaveCSS("opacity", "0");

  // The currently viewed worktree is also part of the multiselection. Its
  // actions must still stay out of the way until the user asks for them.
  await restRow.click();
  await expect(restRow).toHaveClass(/is-selected/);
  await window.getByRole("button", { name: /Add folders/i }).hover();
  await expect(menu).toHaveCSS("opacity", "0");

  // Re-hover inside the retry: boot-time repo refreshes can re-render the row
  // list right after a hover lands, eating the :hover state.
  await expect(async () => {
    await restRow.hover();
    await expect(acts).toHaveCSS("opacity", "1", { timeout: 500 });
    await expect(menu).toHaveCSS("opacity", "1", { timeout: 500 });
  }).toPass({ timeout: 10_000 });

  // The button remains reachable and visible with the keyboard even though it
  // is visually quiet at rest.
  await restRow.focus();
  await window.keyboard.press("Tab");
  await window.keyboard.press("Tab");
  await expect(menu.getByRole("button", { name: "Worktree actions" })).toBeFocused();
  await expect(menu).toHaveCSS("opacity", "1");
});

test("keeps the primary and pinned worktrees visible when the remaining list is collapsed", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("navigation", {
    worktrees: ["feature/favorite", "feature/other"]
  });
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "navigation");

  const favorite = branchRow(window, "feature/favorite");
  await favorite.hover();
  await favorite.getByRole("button", { name: "Pin worktree" }).click();
  await expect(
    window.locator(".wt-section__elevated").filter({
      has: window.locator(".wt-row__branch", { hasText: "feature/favorite" })
    })
  ).toBeVisible();

  // Collapsing is setup for what this test is actually about, so it goes
  // through the helper: a bare click here can be dropped, and the failure would
  // land on the visibility assertions below rather than on the collapse.
  const worktreesToggle = await collapseWorktrees(window, "navigation");
  await expect(
    worktreesToggle.locator(".ref-section__count")
  ).toHaveText("1");
  await expect(branchRow(window, "main")).toBeVisible();
  await expect(branchRow(window, "feature/favorite")).toBeVisible();
  await expect(branchRow(window, "feature/other")).toHaveCount(0);
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

  const created = branchRow(window, "feature/e2e-created");
  await expect(created).toBeVisible({ timeout: 20_000 });
  // Creating a worktree takes you to it — otherwise it lands unfound among a
  // repo's other hundred and the user has to hunt for what they just made.
  await expect(created).toHaveAttribute("aria-selected", "true", {
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
  sandbox.commitEmptyAt(linked, "old worktree activity", 1_700_000_000);
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "delta");
  await expect(branchRow(window, "feature/old")).toBeVisible();

  // Lives in the Worktrees section head, not the repo row — the repo toolbar
  // already spends the circular-arrows glyph on Fetch, so this one has to be
  // positioned where it can only mean "re-list these worktrees".
  const refresh = window
    .locator(".wt-section__head")
    .getByRole("button", { name: "Refresh worktrees for delta" });
  await refresh.hover();
  await expect(window.getByRole("tooltip")).toContainText(
    /re-read Git for worktrees added, removed, or switched outside PwrGit/
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
  await expect(
    window.locator(".wt-section__body .wt-row__branch").first()
  ).toHaveText("external/new");
  await expect(window.locator(".app-toast__message")).toHaveText(
    "1 discovered · 1 updated"
  );

  await window.getByRole("button", { name: "Dismiss" }).click();
  await refresh.click();
  await expect(window.locator(".app-toast__message")).toHaveText(
    "Worktree list is up to date."
  );

  // Reconciliation updates the command-palette search index in the same
  // transaction, not only the visible sidebar rows.
  await window.getByRole("button", { name: /Jump to repo/i }).click();
  await window.locator(".overlay-search input").fill("rbac");
  await expect(window.locator(".overlay-result__name")).toHaveText(
    "feat/messaging-rbac-permissions"
  );
});

test("removing the selected worktree clears its commits from search", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("vanished-timeline");
  const linked = repo.addWorktree("feature/gone");
  sandbox.commit(linked, "gone.txt", "vanishing timeline commit");
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "vanished-timeline");
  await branchRow(window, "feature/gone").click();
  await expect(
    window.locator(".graph-row", { hasText: "vanishing timeline commit" })
  ).toBeVisible({ timeout: 20_000 });

  sandbox.git(repo.path, "worktree", "remove", "--force", linked);
  await window
    .locator(".wt-section__head")
    .getByRole("button", { name: "Refresh worktrees for vanished-timeline" })
    .click();
  await expect(branchRow(window, "feature/gone")).toHaveCount(0);

  await window.getByRole("button", { name: /Jump to repo/i }).click();
  await window.locator(".overlay-search input").fill("vanishing timeline commit");
  await expect(
    window.locator(".overlay-result", { hasText: "vanishing timeline commit" })
  ).toHaveCount(0);
  await expect(window.locator(".overlay-empty")).toContainText(
    "Nothing matches"
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
