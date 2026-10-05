import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, collapseWorktrees } from "./fixtures/steps";

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

// The report this answers: a jump into a worktree behind the closed "Other
// worktrees" list opened that list (and saved it open), and nothing could take
// the reader back to where they had been.
test("a jump shows a ghost row instead of opening the list, and Back returns", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("trailhead");
  for (let i = 0; i < 6; i += 1) repo.addWorktree(`feature/far-${i}`);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "trailhead");

  // Start on the primary checkout, with the worktree list closed.
  await window
    .locator(".wt-row", { has: window.locator(".wt-tag--local") })
    .locator(".wt-row__branch")
    .click();
  const start = window.locator(".titlebar__branch-name");
  await expect(start).not.toHaveText("");
  const startBranch = (await start.textContent()) ?? "";
  const toggle = await collapseWorktrees(window, "trailhead");

  const back = window.getByTestId("history-nav-back");
  const forward = window.getByTestId("history-nav-forward");
  await expect(back).toBeDisabled();

  // Jump through ⌘F to a worktree that lives in the closed list.
  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("feature/far-4");
  await expect(window.locator(".overlay-result").first()).toContainText(
    "feature/far-4"
  );
  await window.keyboard.press("Enter");
  await expect(window.locator(".titlebar__branch-name")).toHaveText(
    "feature/far-4",
    { timeout: 20_000 }
  );

  // Shown as a ghost at the foot of the visible block; the list stays shut.
  const ghost = window.locator(".wt-row.is-ghost.is-selected");
  await expect(ghost).toContainText("feature/far-4");
  await expect(ghost).toBeInViewport();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Back returns, and the ghost leaves with the selection.
  await expect(back).toBeEnabled();
  await back.click();
  await expect(window.locator(".titlebar__branch-name")).toHaveText(startBranch);
  await expect(window.locator(".wt-row.is-ghost")).toHaveCount(0);

  // Forward, from the keyboard: ⌘] on macOS, Ctrl+] elsewhere.
  await expect(forward).toBeEnabled();
  await window.keyboard.press("ControlOrMeta+BracketRight");
  await expect(window.locator(".titlebar__branch-name")).toHaveText(
    "feature/far-4"
  );

  // Right-click Back for the list of places; Escape closes it.
  await back.click({ button: "right" });
  const menu = window.getByRole("menu", { name: "History" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toContainText(
    "feature/far-4"
  );
  await expect(menu).toContainText(startBranch);
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});
