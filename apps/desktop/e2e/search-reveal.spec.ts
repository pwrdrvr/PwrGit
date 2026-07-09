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
