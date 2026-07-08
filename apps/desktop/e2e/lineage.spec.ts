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

test("multi-lane lineage shows active branches and hides merged ones", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("gdemo");

  // An active worktree branch with unmerged work.
  const login = repo.addWorktree("feat/login");
  sandbox.commit(login, "login.txt", "start login flow");

  // A branch that gets merged into main → should be hidden by default.
  const tidy = repo.addWorktree("chore/tidy");
  sandbox.commit(tidy, "tidy.txt", "tidy imports");
  sandbox.git(repo.path, "merge", "--no-ff", "chore/tidy", "-m", "merge tidy");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "gdemo");
  await branchRow(window, "main").first().click();

  // Active view: the unmerged branch is drawn (its tip labelled); the merged
  // one is not in the active set, so the "hidden" hint appears.
  await expect(window.locator(".ref-chip", { hasText: "feat/login" })).toBeVisible({
    timeout: 20_000
  });
  await expect(window.locator(".graph-toolbar__count")).toHaveText(
    /1 active branch\b/
  );
  const hint = window.locator(".graph-hidden-note");
  await expect(hint).toBeVisible();

  // Reveal everything — the hint disappears and the toggle flips label.
  await hint.locator("button").click();
  await expect(window.locator(".only-me")).toHaveText(/All branches/);
  await expect(hint).toBeHidden();
});
