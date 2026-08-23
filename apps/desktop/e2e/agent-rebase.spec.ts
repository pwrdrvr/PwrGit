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

test("an unavailable agent leaves the deterministic isolated rebase workflow usable", async () => {
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
    await row.getByRole("checkbox", { name: "Select for rebase" }).click();
  }
  await window.getByRole("button", { name: "Squash", exact: true }).click();

  await expect(window.locator(".rebase-plan")).toContainText("pick");
  await expect(window.locator(".rebase-plan")).toContainText("squash");
  await expect(window.locator(".rebase-agent__status")).toContainText(
    "No safe agent"
  );
  await expect(window.locator(".rebase-agent__status")).toContainText(
    "deterministic plan"
  );

  const check = window.getByRole("button", { name: "Check in isolated copy" });
  await expect(check).toBeEnabled();
  await check.click();
  await expect(window.locator(".rebase-check-result--clean")).toContainText(
    "Check passed",
    { timeout: 20_000 }
  );
  await expect(window.getByRole("button", { name: "Apply rebase" })).toBeEnabled();

  // The test intentionally stops before Apply: discovery and drafting must not
  // mutate history, and the final local rewrite remains a distinct user action.
  expect(sandbox.git(repo.path, "rev-list", "--count", "HEAD")).toBe("3");
});
