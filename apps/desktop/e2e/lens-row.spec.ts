import { expect, test, type Page } from "@playwright/test";
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

/**
 * Does the lens row fit inside the sidebar?
 *
 * This replaces a per-chip glyph-clipping measurement. The old row was five
 * text chips in a fixed five-track grid, and the failure mode was a label
 * losing glyphs off both edges — so the guard had to measure content vs. track
 * with a Range. Icons are fixed-size, so the only thing that can go wrong now
 * is the ROW overflowing its container, which is one measurement.
 */
async function lensRowOverflow(window: Page): Promise<number> {
  return window.locator(".lens-filter").evaluate((el) => {
    const parent = el.parentElement;
    if (parent === null) return 0;
    return Math.round(
      (el.getBoundingClientRect().right - parent.getBoundingClientRect().right) *
        100
    ) / 100;
  });
}

test("the lens row fits, and names every lens for the keyboard", async () => {
  sandbox = createGitSandbox();
  // A three-digit "All" and a real "Behind" count — the pairing that used to
  // overrun the equal-width tracks.
  for (let i = 0; i < 12; i += 1) {
    sandbox.makeRepo(`repo-${String(i).padStart(2, "0")}`);
  }
  for (const name of ["behind-a", "behind-b", "behind-c"]) {
    sandbox.makeRepoBehindRemote(name, { behindBy: 2 });
  }

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(15, {
    timeout: 20_000
  });

  // Icons carry no text, so the count each label used to show has to survive in
  // the accessible name — otherwise the information is simply gone. "All" is
  // the count to assert on: it's just repos.length, whereas Behind/Stale read
  // per-worktree state that is computed lazily when a repo is expanded, so
  // they are legitimately 0 on a list nobody has opened yet.
  await expect(lensChip(window, "All")).toHaveAttribute(
    "aria-label",
    /^All \(15\)$/
  );
  // The other branch of the same logic: a lens with nothing in it carries no
  // parenthetical and no dot, so neither is decoration.
  await expect(lensChip(window, "Recent")).toHaveAttribute("aria-label", "Recent");
  await expect(lensChip(window, "Recent").locator(".lens-chip__dot")).toHaveCount(0);
  await expect(lensChip(window, "All").locator(".lens-chip__dot")).toHaveCount(1);
  // The active lens still spells its count out.
  await expect(window.locator(".lens-filter__count")).toHaveText("15");

  expect(await lensRowOverflow(window)).toBeLessThanOrEqual(0);
});

test("the lens row survives the narrowest sidebar at the largest text size", async () => {
  sandbox = createGitSandbox();
  for (let i = 0; i < 12; i += 1) {
    sandbox.makeRepo(`repo-${String(i).padStart(2, "0")}`);
  }

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(12, {
    timeout: 20_000
  });

  // 240 is useColumnResize's floor. Combined with the largest text notch this
  // is the case the OLD row could not survive at all: its own CSS note recorded
  // "Pinned 13" clearing by ~0.5px at 320px, so one notch overflowed it. Icons
  // don't read the type scale, which is the whole point of the change.
  await window.evaluate(() => {
    window.localStorage.setItem("pwrgit.sidebarWidth", "240");
    document.documentElement.setAttribute("data-sidebar-text", "xl");
  });
  await window.reload();
  await window.evaluate(() =>
    document.documentElement.setAttribute("data-sidebar-text", "xl")
  );
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(12, {
    timeout: 20_000
  });

  // The names did grow — otherwise this asserts nothing about the notch.
  const nameSize = await window
    .locator(".repo-row__name")
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(nameSize).toBe("15px");

  expect(await lensRowOverflow(window)).toBeLessThanOrEqual(0);
});
