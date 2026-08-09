import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";

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

/**
 * The point of hover-gating the star inside the Pinned lens is that the lens
 * reads quiet: every row there is pinned, so a column of lit stars spends the
 * accent color to repeat the header. A row that keeps its star for an
 * incidental reason (it happens to still hold focus, it happens to be first)
 * is worse than showing all of them — the lit ones look like they mean
 * something.
 */
test("the Pinned lens shows no stars when the pointer is away", async () => {
  sandbox = createGitSandbox();
  for (const name of ["alpha", "bravo", "charlie"]) sandbox.makeRepo(name);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await window.locator(".lens-chip", { hasText: "All" }).click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3, {
    timeout: 20_000
  });
  for (const name of ["alpha", "bravo", "charlie"]) {
    await window
      .locator(".repo-row", { hasText: name })
      .locator(".pin")
      .click();
  }
  await window.locator(".lens-chip", { hasText: "Pinned" }).click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);

  // Park the pointer well clear of the list and drop focus to the body, so
  // nothing is hovered or focused for an incidental reason.
  await window.mouse.move(2000, 2000);
  await window.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

  // `toHaveCSS` retries, which matters here: the star fades over 120ms, so a
  // one-shot read of computed opacity samples the transition mid-flight and
  // reports a lit star that is actually on its way out.
  const pins = window.locator(".repo-row .pin");
  await expect(pins).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await expect(pins.nth(i)).toHaveCSS("opacity", "0");
  }
});
