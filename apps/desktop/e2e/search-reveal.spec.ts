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

test("⌘F search pick expands the repo, selects Local, and scrolls it into view", async () => {
  sandbox = createGitSandbox();
  // A branch-heavy repo that sorts FIRST — expanded, its worktrees push
  // everything below it out of the sidebar viewport.
  const park = sandbox.makeRepo("aaa-park");
  for (let i = 0; i < 25; i += 1) {
    park.addWorktree(`wt/pad-${String(i).padStart(2, "0")}`);
  }
  sandbox.makeRepo("agent-kit");

  handle = await launchApp();
  const { window } = handle;
  // Expands aaa-park (26 rows) so agent-kit's row is far below the fold.
  await addRootAndExpand(window, handle, sandbox, "aaa-park");

  // Find via ⌘F (alias of ⌘K), pick agent-kit with Enter.
  await window.keyboard.press("Meta+f");
  await expect(window.locator(".overlay-panel")).toBeVisible();
  await window.locator(".overlay-search input").fill("agent-kit");
  await window.keyboard.press("Enter");

  // The main pane switched to agent-kit…
  await expect(window.locator(".wt-header__repo")).toHaveText("agent-kit", {
    timeout: 20_000
  });
  // …AND the sidebar expanded it, selected its Local checkout, and scrolled
  // the row into view (it was below an expanded 26-row repo).
  const selected = window.locator(".wt-row.is-selected");
  await expect(selected.locator(".wt-tag--local")).toBeVisible();
  await expect(selected).toBeInViewport();
});

test("moving selection via ⌘F leaves no second 'selected-looking' row behind", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha-kit");
  sandbox.makeRepo("bravo-park");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "bravo-park");

  // A real sidebar click on bravo's Local row — this also seeds the batch
  // (shift-range) set with that row.
  await window
    .locator(".repo-block", { hasText: "bravo-park" })
    .locator(".wt-row")
    .first()
    .click();

  // Now move the selection from OUTSIDE the sidebar: ⌘F → pick alpha-kit.
  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("alpha-kit");
  await window.keyboard.press("Enter");
  await expect(window.locator(".wt-header__repo")).toHaveText("alpha-kit", {
    timeout: 20_000
  });

  // Exactly ONE row may look selected. The active row itself may carry the
  // batch class too (CSS neutralizes the combo) — what must NOT exist is a
  // batch-tinted row that isn't the selected one (the "two selected repos at
  // once" bug), and bravo must have no lit rows at all.
  await expect(window.locator(".wt-row.is-selected")).toHaveCount(1);
  await expect(
    window.locator(".wt-row.is-multiselected:not(.is-selected)")
  ).toHaveCount(0);
  const bravo = window.locator(".repo-block", { hasText: "bravo-park" });
  await expect(bravo.locator(".wt-row.is-selected")).toHaveCount(0);
  await expect(bravo.locator(".wt-row.is-multiselected")).toHaveCount(0);
  await expect(
    window
      .locator(".repo-block", { hasText: "alpha-kit" })
      .locator(".wt-row.is-selected")
  ).toHaveCount(1);
});
