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

test("checks a manual Squash in isolation", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("csv-export");
  sandbox.commit(repo.path, "one.txt", "first focused change");
  sandbox.commit(repo.path, "two.txt", "second focused change");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, repo.name);
  await branchRow(window, "main").first().click();

  // The run starts at the commit right-clicked and ends at HEAD.
  const oldest = window.locator(".graph-row", { hasText: "first focused change" });
  await expect(oldest).toBeVisible({ timeout: 20_000 });
  await oldest.locator(".commit-msg").click({ button: "right" });
  await expect(window.getByRole("menuitem", { name: "Reorder 2 commits…" })).toBeVisible();
  await expect(window.getByRole("menuitem", { name: /Tidy/ })).toHaveCount(0);
  await window.getByRole("menuitem", { name: "Squash 2 commits into one…" }).click();
  await expect(window.locator(".graph-row.is-selected")).toHaveCount(2);
  await expect(window.locator(".selection-bar")).toContainText("Reorder");
  await expect(window.locator(".selection-bar")).not.toContainText("Tidy");

  await expect(window.locator(".agent-chip")).toHaveCount(0);
  await expect(window.locator(".rebase-plan")).toContainText("pick");
  await expect(window.locator(".rebase-plan")).toContainText("squash");
  await expect(window.locator(".msg-box__input")).toHaveValue(
    "first focused change\n\nsecond focused change"
  );
  await expect(window.locator(".proof-ledger")).toContainText("needs replay");

  const check = window.getByRole("button", { name: "Check in isolated copy" });
  await expect(check).toBeEnabled();
  await check.click();
  await expect(window.locator(".rebase-check-result--clean")).toContainText(
    "Check passed",
    { timeout: 20_000 }
  );
  await expect(window.getByRole("button", { name: "Apply rebase" })).toBeEnabled();
  await expect(window.locator(".proof-ledger")).toContainText("Replays cleanly");
  await expect(window.locator(".proof-ledger")).not.toContainText("needs replay");

  // The test intentionally stops before Apply: the check must not mutate
  // history, and the final local rewrite remains a distinct user action.
  expect(sandbox.git(repo.path, "rev-list", "--count", "HEAD")).toBe("3");
});
