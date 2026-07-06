import { expect, type Locator, type Page } from "@playwright/test";
import type { AppHandle } from "./electron-app";
import type { GitSandbox } from "./git-sandbox";

/** Add the sandbox as a repo folder (via the stubbed picker), switch to the All
    lens so nothing is filtered out, then wait for `repoName` and expand it. */
export async function addRootAndExpand(
  window: Page,
  app: AppHandle,
  box: GitSandbox,
  repoName: string
): Promise<void> {
  await app.setPickDirectory(box.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await window.locator(".lens-chip", { hasText: "All" }).click();
  const repoRow = window.locator(".repo-row__name", { hasText: repoName });
  await expect(repoRow).toBeVisible({ timeout: 20_000 });
  await repoRow.click();
}

export const branchRow = (window: Page, branch: string): Locator =>
  window.locator(".wt-row").filter({ hasText: branch });
