import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, primaryShortcut, repoGroup } from "./fixtures/steps";

// Hide and Remove, from the repository row's menu.
// design/Remove and Hide Repository - UX Review.dc.html.

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;
let trashDir: string | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
  if (trashDir !== null) rmSync(trashDir, { recursive: true, force: true });
  trashDir = null;
});

test("hides a repository and brings it back from the sidebar and from ⌘K", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("harbor-api", { worktrees: ["feat/one"] });
  sandbox.makeRepo("lantern-web");
  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "harbor-api");

  await repoGroup(window, "harbor-api").locator(".repo-row__name").click({ button: "right" });
  await window.getByRole("menuitem", { name: /^Hide repository/ }).click();

  // No confirmation: it loses nothing, and the toast can undo it.
  await expect(repoGroup(window, "harbor-api")).toHaveCount(0);
  await expect(repoGroup(window, "lantern-web")).toBeVisible();
  await expect(window.getByText("Hid harbor-api")).toBeVisible();
  const hidden = window.getByRole("button", { name: /^Hidden\s*1$/ });
  await expect(hidden).toBeVisible();

  await hidden.click();
  await window.getByRole("menuitem", { name: /^Unhide harbor-api/ }).click();
  await expect(repoGroup(window, "harbor-api")).toBeVisible();
  await expect(hidden).toHaveCount(0);

  // Hidden again, then named in full in the palette: Return unhides it.
  await repoGroup(window, "harbor-api").locator(".repo-row__name").click({ button: "right" });
  await window.getByRole("menuitem", { name: /^Hide repository/ }).click();
  await expect(repoGroup(window, "harbor-api")).toHaveCount(0);
  await window.keyboard.press(primaryShortcut("k"));
  await window.keyboard.type("harbor-api");
  const row = window.locator(".overlay-result--hidden", { hasText: "harbor-api" });
  await expect(row).toContainText("Return to unhide");
  await window.keyboard.press("Enter");
  await expect(repoGroup(window, "harbor-api")).toBeVisible();
});

test("removes a repository and its worktrees to the Trash after an explicit choice", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoWithRemote("harbor-api");
  const clean = repo.addWorktree("feat/clean");
  const dirty = repo.addWorktree("feat/dirty", { dirty: true });
  sandbox.makeRepo("lantern-web");
  trashDir = mkdtempSync(join(tmpdir(), "pwrgit-e2e-trash-"));
  handle = await launchApp({ trashDir });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "harbor-api");

  await repoGroup(window, "harbor-api").locator(".repo-row__name").click({ button: "right" });
  await window.getByRole("menuitem", { name: /^Remove repository…/ }).click();

  // By class: the dialog's title, and so its name, becomes the outcome.
  const dialog = window.locator(".modal--remove-repo");
  await expect(dialog.locator(".modal__title")).toHaveText("Remove harbor-api from disk");
  await expect(dialog).toContainText("1 untracked file");
  await expect(dialog).toContainText("1 needs a choice · 2 safe");
  // Cancel holds focus, and the danger button waits for the answer.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const remove = dialog.locator(".modal__create--danger");
  await expect(remove).toBeDisabled();

  await dialog
    .getByRole("radiogroup", { name: "What to do with feat/dirty" })
    .getByRole("radio", { name: "Discard" })
    .click();
  await expect(remove).toHaveText("Remove harbor-api");
  await expect(remove).toBeDisabled();
  await dialog.locator(".remove-repo__gate input").fill("harbor-api");
  await remove.click();

  await expect(dialog).toContainText("Removed harbor-api");
  await expect(dialog).toContainText("3 folders");
  for (const path of [repo.path, clean, dirty]) expect(existsSync(path)).toBe(false);
  expect(readdirSync(trashDir)).toHaveLength(3);
  // The remote is not touched.
  expect(existsSync(repo.remotePath)).toBe(true);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(repoGroup(window, "harbor-api")).toHaveCount(0);
  await expect(repoGroup(window, "lantern-web")).toBeVisible();
});
