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

  // The primary branch trails origin by 2 → the row shows a ↓2 badge.
  const behindBadge = branchRow(window, "main").locator(".badge-text--warn");
  await expect(behindBadge).toHaveText("↓2", { timeout: 20_000 });

  // Pull = fetch + fast-forward.
  await window.getByRole("button", { name: /^Pull/ }).click();

  // The badge must clear — the sidebar reads `behind` from the repo tree, so the
  // single-worktree refresh has to nudge repo:changed, not just worktree:changed.
  await expect(behindBadge).toHaveCount(0, { timeout: 20_000 });
});
