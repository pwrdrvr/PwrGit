import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("worktree and rail header dividers align", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("aligned-headers");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "aligned-headers");

  const [worktreeBottom, railBottom] = await Promise.all([
    window
      .locator(".wt-header")
      .evaluate((element) => element.getBoundingClientRect().bottom),
    window
      .locator(".rail__bar")
      .evaluate((element) => element.getBoundingClientRect().bottom)
  ]);

  expect(railBottom).toBe(worktreeBottom);
});

test("discarding a file's changes returns the worktree to clean", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("dsc");
  writeFileSync(join(repo.path, "README.md"), "# dsc\nunwanted edit\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "dsc");

  const fileRow = window.locator(".file-row", { hasText: "README.md" });
  await expect(fileRow).toBeVisible({ timeout: 20_000 });

  await fileRow.hover();
  await fileRow.locator(".file-discard").click();
  // Destructive → in-app confirm dialog (not a native one).
  await window.locator(".modal--dialog .modal__create").click();

  await expect(window.locator(".changes-clean")).toBeVisible({ timeout: 20_000 });
});

test("pulling with local edits auto-stashes and reapplies them", async () => {
  sandbox = createGitSandbox();
  // Primary trails origin by 1 (the incoming commit adds a *new* file), plus a
  // local uncommitted edit to a tracked file — the exact "your local changes
  // would be overwritten" setup, handled by stash → ff → pop.
  const repo = sandbox.makeRepoBehindRemote("svc", { behindBy: 1 });
  writeFileSync(join(repo.path, "README.md"), "# svc\nlocal work in progress\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "svc");

  const behindBadge = branchRow(window, "main").locator(".badge-text--warn");
  await expect(behindBadge).toHaveText("↓1", { timeout: 20_000 });
  await expect(
    window.locator(".file-row", { hasText: "README.md" })
  ).toBeVisible();

  await window.getByRole("button", { name: /^Pull/ }).click();

  // The fast-forward landed (badge cleared) AND the local edit survived (still
  // listed as a change) — it was stashed and reapplied, not overwritten.
  await expect(behindBadge).toHaveCount(0, { timeout: 20_000 });
  await expect(
    window.locator(".file-row", { hasText: "README.md" })
  ).toBeVisible();
});
