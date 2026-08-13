import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandWorktrees,
  repoGroup
} from "./fixtures/steps";

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

/** Swallow the first click that lands on `selector`, the way a re-render
    already in flight does when the sidebar is indexing a freshly added root.
    Capture on `document` runs before React's root listener, so the app never
    sees the click at all. */
async function dropFirstClickOn(
  window: AppHandle["window"],
  selector: string
): Promise<void> {
  await window.evaluate((sel) => {
    const swallow = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(sel) === null) return;
      event.stopPropagation();
      document.removeEventListener("click", swallow, true);
    };
    document.addEventListener("click", swallow, true);
  }, selector);
}

// The flake this guards: a lost expand click used to surface 20-30s later as a
// missing `.wt-row` in whatever the spec asserted next. The helpers read
// `aria-expanded` back, so the click retries in place instead.
test("the expand helpers recover a dropped repo-group click", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("dropped", { worktrees: ["feature/one"] });
  handle = await launchApp();
  const { window } = handle;

  await dropFirstClickOn(window, ".repo-row");
  await addRootAndExpand(window, handle, sandbox, "dropped");

  await expect(repoGroup(window, "dropped")).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect(branchRow(window, "main")).toBeVisible();
});

test("the expand helpers recover a dropped Worktrees-section click", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("dropped-section", { worktrees: ["feature/one"] });
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "dropped-section");
  // Close the section so the helper has real work to do, then eat the reopen.
  const toggle = window.locator(".wt-section__toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await dropFirstClickOn(window, ".wt-section__toggle");
  await expandWorktrees(window, "dropped-section");

  await expect(branchRow(window, "feature/one")).toBeVisible();
});
