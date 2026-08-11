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

test("Pull fast-forwards and clears the ↓behind badge in the sidebar", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepoBehindRemote("svc", { behindBy: 2 });
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "svc");

  // The primary branch trails origin by 2 → both the row badge and the folder
  // badge (which reflects the primary checkout) show ↓2.
  const behindBadge = branchRow(window, "main").locator(".badge-text--warn");
  const folderBadge = window
    .locator(".repo-row", { hasText: "svc" })
    .locator(".badge--warn");
  await expect(behindBadge).toHaveText("↓2", { timeout: 20_000 });
  await expect(folderBadge).toHaveText("↓2");

  // Pull = fetch + fast-forward.
  await window.getByRole("button", { name: /^Pull/ }).click();

  // Both must clear — the sidebar reads `behind` from the repo tree, so the
  // single-worktree refresh has to nudge repo:changed, not just worktree:changed.
  await expect(behindBadge).toHaveCount(0, { timeout: 20_000 });
  await expect(folderBadge).toHaveCount(0);
});

test("a synced release branch distinguishes default-branch drift from commits to pull", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoWithSyncedReleaseBranch("release", {
    mainAheadBy: 4,
    backports: 2
  });
  // Keep main as the resolved default ref without leaving any worktree on it.
  // The display name must come from the same resolution as behindDefault, not
  // from whichever branches happen to be checked out right now.
  sandbox.git(repo.path, "switch", "-c", "feature/current");
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, sandbox, "release");
  const worktrees = window.getByRole("button", { name: /^Worktrees 1/ });
  if ((await worktrees.count()) === 0) {
    await window
      .getByRole("treeitem", { name: "release", exact: true })
      .click();
  }
  await expect(worktrees).toBeVisible({ timeout: 20_000 });
  if ((await worktrees.getAttribute("aria-expanded")) !== "true") {
    await worktrees.click();
  }

  const release = branchRow(window, "releases/1.0");
  await expect(release).toBeVisible({ timeout: 20_000 });
  // origin/releases/1.0 is synchronized, so this is not incoming Pull work.
  await expect(release.locator(".badge-text--warn")).toHaveCount(0, {
    timeout: 20_000
  });
  // main has four commits not in the release branch. Keep that useful
  // staleness signal, but visibly identify the other side of the comparison.
  await expect(release.locator(".wt-tag--default-ahead")).toHaveText(
    "main +4"
  );
  await expect(release.locator(".wt-tag--default-ahead")).toHaveAttribute(
    "title",
    "main has 4 commits not in releases/1.0; this is not commits available to pull"
  );
});

test("a diverged pull explains the comparison and can reset a clean local branch", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("rewritten", { behindBy: 1 });
  // Recreate the remote-only commit with the same patch + subject but a
  // different identity. This is the shape a remote rebase/force-push leaves:
  // matching labels, different commit object IDs.
  box.commitAs(
    "local-rewrite@pwrgit.dev",
    repo.path,
    "remote-0.txt",
    "remote commit 0"
  );
  handle = await launchApp();
  const { window } = handle;

  await addRootAndExpand(window, handle, box, "rewritten");
  await window.getByRole("button", { name: /^Pull/ }).click();

  const dialog = window.locator(".pull-divergence");
  await expect(dialog).toContainText("Branch histories diverged");
  await expect(dialog).toContainText("Local only");
  await expect(dialog).toContainText("Remote only");
  await expect(dialog).toContainText("Working tree");
  await expect(dialog).toContainText("Clean");
  await expect(dialog).toContainText(
    "same number of commits with matching messages"
  );
  await expect(dialog).toContainText("remote commit 0");
  await expect(
    dialog.getByRole("button", { name: "Rebase local commits" })
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Reset to remote…" })
  ).toBeEnabled();

  await dialog.getByRole("button", { name: "Reset to remote…" }).click();
  await expect(dialog).toContainText("Reset local branch to remote?");
  await dialog.getByRole("button", { name: "Reset to remote" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => box.git(repo.path, "rev-parse", "HEAD")).toBe(
    box.git(repo.path, "rev-parse", "origin/main")
  );
});
