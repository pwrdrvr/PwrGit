import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandWorktrees
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
  const worktrees = await expandWorktrees(window, "release");
  // The count only reaches 1 once the linked worktree is indexed, so give it
  // the same room the old inline wait had.
  await expect(worktrees.locator(".ref-section__count")).toHaveText("1", {
    timeout: 20_000
  });

  const release = branchRow(window, "releases/1.0");
  await expect(release).toBeVisible({ timeout: 20_000 });
  // origin/releases/1.0 is synchronized, so this is not incoming Pull work.
  await expect(release.locator(".badge-text--warn")).toHaveCount(0, {
    timeout: 20_000
  });
  // The sidebar row is identity + actionable state only: drift belongs to the
  // selected worktree's header, where it can't crowd out the branch name.
  await expect(release.locator(".sync-chip--drift")).toHaveCount(0);
  await expect(release.locator(".wt-row__branch")).toHaveText("releases/1.0");

  await release.click();
  // The header is a size container: below 540px of content it drops the drift
  // chip on purpose. Establish that width here instead of inheriting whatever
  // the runner's screen gives — GitHub's Windows runners are 1024×768, where
  // the main pane is ~360px and the chip is legitimately hidden. Collapsing the
  // rail hands the pane the width a real window has on any screen ≥ 900px.
  await window.getByRole("button", { name: "Collapse panel" }).click();

  // main has four commits not in the release branch. Keep that useful
  // staleness signal, but visibly identify the other side of the comparison.
  const drift = window.locator(".wt-header .sync-chip--drift");
  // Visible, not merely present: toHaveText passes on a display:none element,
  // which is how a breakpoint that hid this chip at every width first shipped
  // green.
  await expect(drift).toBeVisible({ timeout: 20_000 });
  await expect(drift).toHaveText("main +4");
  await expect(drift).toHaveAttribute(
    "title",
    "main has 4 commits not in releases/1.0; this is not commits available to pull"
  );
});

test("a diverged pull aligns rewritten commits, scrolls both histories, and resets", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  // Ten recreated commits model a remote rebase. Two commits exist only on the
  // local branch and three only upstream, so reset risk is visible on both sides.
  const repo = box.makeRepoWithRewrittenDivergence("rewritten", {
    paired: 10,
    localOnly: 2,
    remoteOnly: 3
  });
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
  await expect(dialog).toContainText("Git lined up 10 commits");
  await expect(dialog).toContainText(
    "2 commits appear only locally and 3 commits only upstream"
  );
  await expect(dialog).toContainText("Only on this branch 12 commits");
  await expect(dialog).toContainText("Only on origin/main 13 commits");

  const comparison = dialog.locator(".pull-divergence__comparison-scroll");
  await expect(comparison.locator('[role="row"]')).toHaveCount(15);
  await expect(
    comparison.getByLabel("Corresponding commit with changes")
  ).toHaveCount(10);
  await expect(comparison.getByLabel("Only on the local branch")).toHaveCount(
    2
  );
  await expect(
    comparison.getByLabel("Only on the upstream branch")
  ).toHaveCount(3);
  await expect
    .poll(() =>
      comparison.evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true);

  const alignedRow = comparison.locator('[role="row"]', {
    hasText: "feat: shared change 7"
  });
  await expect(alignedRow.locator(".pull-divergence__commit-subject")).toHaveText([
    "feat: shared change 7",
    "feat: shared change 7"
  ]);
  await expect(alignedRow.locator(".pull-divergence__commit-stats")).toHaveText([
    "+1−0",
    "+1−0"
  ]);
  await comparison.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => comparison.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
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
