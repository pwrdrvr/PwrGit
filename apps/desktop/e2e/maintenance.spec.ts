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

test("collects all repositories and reviews stale local branches without touching dirty work", async ({}, testInfo) => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoBehindRemote("atlas-client");
  sandbox.makeRepoBehindRemote("beacon-api");
  sandbox.git(repo.path, "branch", "feature/finished");
  sandbox.git(repo.path, "push", "-u", "origin", "feature/finished");
  sandbox.git(repo.path, "push", "origin", "--delete", "feature/finished");
  writeFileSync(join(repo.path, "local-notes.txt"), "Keep this local work\n");
  const refs = sandbox.git(repo.path, "show-ref");
  const dirty = sandbox.git(repo.path, "status", "--porcelain");

  handle = await launchApp({
    identity: { name: "Demo Developer", email: "demo@example.test" }
  });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "atlas-client");
  await window
    .getByRole("button", { name: "Garbage collection…", exact: true })
    .click();
  const dialog = window.getByRole("dialog", { name: "Repository maintenance" });
  await expect(dialog.getByRole("radio", { name: /Standard/ })).toBeChecked();
  await dialog.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("maintenance-options.png")
  });
  await dialog
    .getByRole("button", { name: "Run garbage collection", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Finished", {
    timeout: 30_000
  });
  await expect(dialog).toContainText("2 succeeded");
  await expect(dialog.locator(".bulk-sync__repo")).toHaveCount(2);
  await expect(dialog.locator(".bulk-sync__repo").first()).toContainText(
    "Object storage:"
  );
  expect(sandbox.git(repo.path, "show-ref")).toBe(refs);
  expect(sandbox.git(repo.path, "status", "--porcelain")).toBe(dirty);
  await dialog.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("maintenance-results.png")
  });

  await dialog
    .getByRole("button", { name: "Local branches", exact: true })
    .click();
  await expect(dialog).toContainText("Fetch all repos first");
  await dialog
    .getByRole("button", { name: "Review local branches", exact: true })
    .click();
  await expect(dialog).toContainText("1 eligible branch");
  await expect(
    dialog.getByRole("button", { name: "Delete 0 selected local branches" })
  ).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: /feature\/finished.*Missing upstream/ })
    .check();
  await dialog.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("maintenance-branches.png")
  });
  await dialog
    .getByRole("button", { name: "Delete 1 selected local branch" })
    .click();
  await expect(dialog).toContainText("1 local branch deleted; 0 retained");
  expect(sandbox.git(repo.path, "branch", "--list", "feature/finished")).toBe(
    ""
  );
  expect(sandbox.git(repo.path, "status", "--porcelain")).toBe(dirty);
});
