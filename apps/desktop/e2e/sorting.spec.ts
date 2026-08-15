import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { lensChip } from "./fixtures/steps";

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

test("repos sort case-insensitively, not uppercase-first", async () => {
  sandbox = createGitSandbox();
  // Binary (ASCII) ordering would yield: Banana, FFmpeg, Zebra, apple, autoGIF.
  for (const name of ["Zebra", "apple", "Banana", "autoGIF", "FFmpeg"]) {
    sandbox.makeRepo(name);
  }

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();

  const names = window.locator(".repo-row__name");
  await expect(names).toHaveCount(5, { timeout: 20_000 });
  expect(await names.allTextContents()).toEqual([
    "apple",
    "autoGIF",
    "Banana",
    "FFmpeg",
    "Zebra"
  ]);
});
