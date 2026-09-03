import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PWRGIT_PULL_STASH_MESSAGE } from "@pwrgit/shared";
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

async function triggerActiveRefresh(app: AppHandle): Promise<void> {
  await app.app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      // Exercise the same focus hook production uses; no private test channel.
      electronApp.emit("browser-window-focus", {}, win);
    }
  });
}

test("manages the Git-native repository stash stack across worktrees", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("multi-stash");
  const linked = repo.addWorktree("feature/linked");

  writeFileSync(join(repo.path, "README.md"), "# multi-stash\nolder work\n");
  sandbox.git(repo.path, "stash", "push", "-m", "older CLI stash");
  writeFileSync(join(repo.path, "other.txt"), "pull recovery work\n");
  sandbox.git(
    repo.path,
    "stash",
    "push",
    "--include-untracked",
    "-m",
    PWRGIT_PULL_STASH_MESSAGE
  );

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "multi-stash");

  const stashesTab = window.getByRole("button", { name: "Stashes 2" });
  await expect(stashesTab).toBeVisible({ timeout: 20_000 });
  await stashesTab.click();
  await expect(
    window.getByText("One Git stash stack for this repository.")
  ).toBeVisible();
  await expect(window.getByText("PwrGit pull recovery")).toBeVisible();
  await expect(window.getByText("older CLI stash")).toBeVisible();

  // Seed the live repository-stack watcher, then change refs/stash through
  // ordinary Git in ANOTHER linked worktree. The selected worktree's status
  // does not move, so this proves refresh is not piggybacking on Changes.
  await triggerActiveRefresh(handle);
  await window.waitForTimeout(300);
  writeFileSync(join(linked, "late.txt"), "created after launch\n");
  sandbox.git(
    linked,
    "stash",
    "push",
    "--include-untracked",
    "-m",
    "CLI after launch"
  );
  await triggerActiveRefresh(handle);
  await expect(window.getByText("CLI after launch")).toBeVisible({
    timeout: 10_000
  });

  // Inspect the PwrGit-created recovery stash just like any interoperable
  // entry, including its files and complete patch.
  const recovery = window.locator(".stash-entry", {
    hasText: "PwrGit pull recovery"
  });
  await recovery.locator(".stash-entry__toggle").click();
  await expect(recovery.getByText("other.txt")).toBeVisible();
  await recovery.getByRole("button", { name: "View patch" }).click();
  await expect(window.locator(".diff-text", { hasText: "pull recovery work" }))
    .toBeVisible();

  // Pop an explicitly selected non-top entry. It restores into the selected
  // primary worktree and removes only that entry.
  const older = window.locator(".stash-entry", { hasText: "older CLI stash" });
  await older.locator(".stash-entry__toggle").click();
  await older.getByRole("button", { name: "Pop" }).click();
  await expect(window.getByText("older CLI stash")).toHaveCount(0, {
    timeout: 10_000
  });
  await expect(window.getByText("Repository stack · 2")).toBeVisible();

  // Create a named entry from the UI; it is immediately ordinary-Git visible.
  await window.getByLabel("Name this stash").fill("saved from PwrGit");
  await window.getByRole("button", { name: "Stash changes" }).click();
  await expect(
    window.getByRole("button", { name: "Inspect saved from PwrGit" })
  ).toBeVisible({ timeout: 10_000 });
  expect(sandbox.git(repo.path, "stash", "list")).toContain(
    "saved from PwrGit"
  );

  await window.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(window.locator(".changes-clean")).toBeVisible({
    timeout: 10_000
  });
});
