import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("clicking a changed file opens its diff, then back returns to lineage", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("diffrepo");
  // Uncommitted modification to the committed README (adds a line).
  writeFileSync(join(repo.path, "README.md"), "# diffrepo\nbrand new line\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "diffrepo");

  // Changes tab (default) frames the WIP and lists the file.
  await expect(window.locator(".changes-wip")).toBeVisible({ timeout: 20_000 });
  const fileRow = window.locator(".file-row", { hasText: "README.md" });
  await expect(fileRow).toBeVisible();
  await fileRow.click();

  // The diff pane shows the added line as an addition row.
  await expect(window.locator(".diff-pane")).toBeVisible({ timeout: 20_000 });
  await expect(
    window.locator(".diff-row--add", { hasText: "brand new line" })
  ).toBeVisible();

  // Back returns to the lineage graph.
  await window.locator(".diff-pane__back").click();
  await expect(window.locator(".graph-toolbar")).toBeVisible();
});

test("clicking a commit scopes the rail to its files; a file opens its diff", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("commitscope");
  sandbox.commit(repo.path, "second.md", "add second doc");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "commitscope");

  // Click the commit in the lineage → the rail shows THAT commit's files,
  // not a full-pane laundry-list diff.
  await window.locator(".graph-row", { hasText: "add second doc" }).click();
  const commitTab = window.locator(".commit-tab");
  await expect(commitTab).toBeVisible({ timeout: 20_000 });
  await expect(commitTab.locator(".commit-tab__subject")).toHaveText(
    "add second doc"
  );
  await expect(window.locator(".diff-pane")).toHaveCount(0);
  const fileRow = commitTab.locator(".file-row", { hasText: "second.md" });
  await expect(fileRow).toBeVisible();

  // Click the file → a diff scoped to that file within the commit.
  await fileRow.click();
  await expect(window.locator(".diff-pane")).toBeVisible();
  await expect(
    window.locator(".diff-row--add", { hasText: "add second doc" })
  ).toBeVisible();
  await expect(window.locator(".diff-pane__sub")).toContainText("in ");

  // Back → lineage; ‹ Changes → the working-tree view returns.
  await window.locator(".diff-pane__back").click();
  await expect(window.locator(".graph-toolbar")).toBeVisible();
  await commitTab.locator(".commit-tab__close").click();
  await expect(window.locator(".commit-tab")).toHaveCount(0);
  await expect(window.locator(".changes-clean")).toBeVisible();
});
