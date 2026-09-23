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

test("with AI off, the deterministic isolated rebase workflow is whole and usable", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("agent-fallback");
  sandbox.commit(repo.path, "one.txt", "first focused change");
  sandbox.commit(repo.path, "two.txt", "second focused change");

  handle = await launchApp({ agentUnavailable: true });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, repo.name);
  await branchRow(window, "main").first().click();

  for (const subject of ["second focused change", "first focused change"]) {
    const row = window.locator(".graph-row", { hasText: subject });
    await expect(row).toBeVisible({ timeout: 20_000 });
    const selection = row.getByRole("checkbox");
    await selection.click();
    await expect(selection).toBeChecked();
  }
  // AI is off until the operator turns it on, and Tidy is an agent action
  // from the start, so the selection bar offers only the Git operations.
  await expect(window.locator(".selection-bar")).toContainText("Reorder");
  await expect(window.locator(".selection-bar")).not.toContainText("Tidy");
  await window.getByRole("button", { name: "Squash", exact: true }).click();

  await expect(window.locator(".rebase-plan")).toContainText("pick");
  await expect(window.locator(".rebase-plan")).toContainText("squash");
  // AI off is a dashed chip, not a warning and not an offer: the message box
  // is Git's joined subjects and everything below it still works.
  await expect(window.locator(".agent-chip")).toContainText("AI off");
  await expect(window.locator(".msg-foot")).toContainText("Joined from 2 subjects");
  await expect(window.locator(".msg-foot")).not.toContainText("Draft with an agent");
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
