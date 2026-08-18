import { mkdirSync, writeFileSync } from "node:fs";
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
  await fileRow.locator(".file-action--discard").click();
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

/**
 * The reported bug, end to end. Staging a folder always appeared to work — git
 * collapses a wholly-new directory into one status entry, so staging it *does*
 * move the dirty count the worktree refresher compares. Staging a single file
 * moves nothing it compares, so before `changes:changed` the list froze and
 * every later +/- looked dead.
 */
test("every stage and unstage click repaints the list", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("stg");
  writeFileSync(join(repo.path, "README.md"), "# stg\nedited\n");
  mkdirSync(join(repo.path, "design"));
  writeFileSync(join(repo.path, "design", "one.md"), "one\n");
  writeFileSync(join(repo.path, "design", "two.md"), "two\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "stg");

  // Each new file is listed by name, under a folder row that stages the lot.
  // `exact` throughout: getByRole matches a case-insensitive *substring* by
  // default, and "Stage x" is a substring of "Unstage x" — a file listed in
  // both sections would resolve two buttons and fail strict mode at the click.
  const folderStage = window.getByRole("button", {
    name: "Stage all 2 files in design",
    exact: true
  });
  await expect(folderStage).toBeVisible({ timeout: 20_000 });
  await expect(window.locator(".file-row", { hasText: "one.md" })).toBeVisible();
  await folderStage.click();
  await expect(
    window.locator(".file-row.is-staged", { hasText: "one.md" })
  ).toBeVisible({ timeout: 20_000 });

  // …and now the click that used to do nothing visible.
  await window
    .getByRole("button", { name: "Stage README.md", exact: true })
    .click();
  await expect(
    window.locator(".file-row.is-staged", { hasText: "README.md" })
  ).toBeVisible({ timeout: 20_000 });

  await window
    .getByRole("button", { name: "Unstage README.md", exact: true })
    .click();
  await expect(
    window.locator(".file-row.is-staged", { hasText: "README.md" })
  ).toHaveCount(0, { timeout: 20_000 });
});
