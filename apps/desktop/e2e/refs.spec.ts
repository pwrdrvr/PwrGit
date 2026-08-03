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

test("browses local branches and nested remotes, then pushes to a test target", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("refsrepo");
  repo.createBranch("feat/local-only");
  const remoteUrl = box.git(repo.path, "remote", "get-url", "origin");
  box.git(repo.path, "remote", "add", "upstream", remoteUrl);
  box.git(repo.path, "remote", "add", "mac-tests", remoteUrl);
  box.git(repo.path, "fetch", "--all");

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "refsrepo");

  // The primary checkout now belongs inside the collapsible Worktrees group.
  const worktrees = window.getByRole("button", { name: /^Worktrees 1/ });
  await expect(worktrees).toBeVisible();
  await expect(window.locator(".wt-tag--local")).toHaveText("primary");

  await window.getByRole("button", { name: /^Branches/ }).click();
  await expect(window.locator(".ref-branch-row", { hasText: "main" })).toBeVisible();
  await expect(
    window.locator(".ref-branch-row", { hasText: "feat/local-only" })
  ).toBeVisible();

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await expect(window.locator(".ref-remote__main", { hasText: "origin" })).toBeVisible();
  await expect(
    window.locator(".ref-remote__main", { hasText: "upstream" })
  ).toBeVisible();
  await expect(
    window.locator(".ref-remote__main", { hasText: "mac-tests" })
  ).toBeVisible();
  const compactOrigin = window.locator(".ref-remote", {
    has: window.locator(".ref-remote__main", { hasText: "origin" })
  });
  await compactOrigin.locator(".ref-remote__main").click();
  await expect(
    compactOrigin
      .locator(".ref-remote-branch-row", { hasText: "main" })
      .getByTitle("Show checked-out worktree")
  ).toHaveText("●");

  await window
    .getByRole("button", { name: "Manage remotes and remote branches…" })
    .click();
  const browser = window.getByRole("dialog", {
    name: "refsrepo branches and remotes"
  });
  await expect(browser).toBeVisible();

  await browser.getByRole("button", { name: /^Branches/ }).click();
  await browser
    .getByRole("button", { name: "Copy branch name feat/local-only" })
    .click();
  await expect
    .poll(() => window.evaluate(() => navigator.clipboard.readText()))
    .toBe("feat/local-only");
  await browser.getByRole("button", { name: /^Remotes/ }).click();
  const originMain = browser
    .locator(".refs-remote-card", { hasText: "origin" })
    .locator(".refs-remote-branch", { hasText: "main" })
    .first();
  await expect(
    originMain.getByRole("button", { name: "Show worktree" })
  ).toBeVisible();
  await browser.getByRole("button", { name: "Push to remotes…" }).click();

  const push = window.getByRole("dialog", {
    name: "Push refsrepo branch to remotes"
  });
  await expect(push).toBeVisible();
  await push.getByRole("combobox", { name: "Source" }).selectOption({
    label: "main · Local"
  });
  await push.locator(".refs-destination", { hasText: "mac-tests" }).click();
  await push.locator(".refs-field input").fill("playwright/main");
  await push.getByRole("button", { name: "Review push" }).click();
  await expect(push.getByText("Will create")).toBeVisible({ timeout: 20_000 });
  await expect(push.getByText(/Push uses a lease/)).toBeVisible();
  await push
    .getByRole("button", { name: "Copy source branch main" })
    .click();
  await expect
    .poll(() => window.evaluate(() => navigator.clipboard.readText()))
    .toBe("main");
  await push.getByRole("button", { name: "Push to 1 remote" }).click();
  await expect(push.getByText("1 destination updated.")).toBeVisible({
    timeout: 20_000
  });

  await expect
    .poll(() =>
      box.git(repo.path, "ls-remote", "--heads", "origin", "refs/heads/playwright/main")
    )
    .not.toBe("");

  await push.getByRole("button", { name: "Close" }).click();
  await browser.getByRole("button", { name: "Push to remotes…" }).click();
  const equalPush = window.getByRole("dialog", {
    name: "Push refsrepo branch to remotes"
  });
  await equalPush.getByRole("combobox", { name: "Source" }).selectOption({
    label: "main · Local"
  });
  await equalPush.locator(".refs-destination", { hasText: "mac-tests" }).click();
  await equalPush.locator(".refs-field input").fill("playwright/main");
  await equalPush.getByRole("button", { name: "Review push" }).click();
  await expect(equalPush.getByText("Up to date")).toBeVisible({ timeout: 20_000 });
  await expect(
    equalPush.getByRole("button", { name: "Nothing to push" })
  ).toBeDisabled();
  await expect(
    equalPush.getByText("All selected destinations already match the source.")
  ).toBeVisible();
  await equalPush.getByRole("button", { name: "Cancel" }).click();

  await browser.getByRole("button", { name: "Add remote…" }).click();
  const editor = window.getByRole("dialog", { name: "Add remote" });
  const fields = editor.locator(".refs-field input");
  await fields.nth(0).fill("backup");
  await fields.nth(1).fill(remoteUrl);
  await editor.getByRole("button", { name: "Add remote" }).click();
  const backup = browser.locator(".refs-remote-card", { hasText: "backup" });
  await expect(backup).toBeVisible();

  await backup.getByRole("button", { name: "Remove" }).click();
  await window.getByRole("button", { name: "Remove remote" }).click();
  await expect(backup).toHaveCount(0);

  await browser.getByRole("button", { name: "Close" }).click();
  const localOnly = window.locator(".ref-branch-row", {
    hasText: "feat/local-only"
  });
  await localOnly.getByTitle("Create worktree").click();
  const newWorktree = window.locator(".modal", { hasText: "New worktree" });
  await newWorktree.getByRole("button", { name: "Create" }).click();
  await expect(
    localOnly.getByTitle("Show checked-out worktree")
  ).toBeVisible({ timeout: 20_000 });
});
