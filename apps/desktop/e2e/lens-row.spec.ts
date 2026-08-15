import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { expandRepoGroup, lensChip } from "./fixtures/steps";

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

test("sidebar rows are sized by their content, not by a fixed box", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("dense", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  const repoRow = window.locator(".repo-row", { hasText: "dense" });
  await expect(repoRow).toBeVisible({ timeout: 20_000 });

  // The point of content-sizing is that the row tracks its type. Guarding the
  // rendered height is the only way to catch the failure that actually
  // happened: `height` was removed, but a fixed 24px pin button silently
  // became the new floor, so the row stayed ~32px and the density work bought
  // nothing. Shrinking it to 20px still left the pin in charge at 30px.
  //
  // The floor here is arithmetic, not taste: a 13px name at line-height 1.25
  // is 16.25px, plus 3px padding top and bottom and a 1px border, so ~24px is
  // as short as this row goes at the default notch — which is also where
  // PwrAgnt's directory rows sit. 26 leaves room for host font rounding while
  // still catching a fixed-size child (pin, badge, kebab) taking over again;
  // the first two attempts at this change stalled at 32px and 30px exactly
  // that way, and this bound at 29 waved the second one through.
  const repoHeight = await repoRow.evaluate((el) => el.getBoundingClientRect().height);
  expect(repoHeight).toBeLessThanOrEqual(26);

  // Worktree rows have the same trap in a different child — the 24px kebab —
  // so guard them too. 11px mono at 1.25 is 13.75, + 2px padding each side + 2
  // border ≈ 20; 22 is the rounding allowance.
  await expandRepoGroup(window, "dense");
  const wtRow = window.locator(".wt-row").first();
  await expect(wtRow).toBeVisible();
  const wtHeight = await wtRow.evaluate((el) => el.getBoundingClientRect().height);
  expect(wtHeight).toBeLessThanOrEqual(22);

  // And it must actually GROW with the axis — a row that ignores the notch
  // would also pass the bound above.
  await window.evaluate(() =>
    document.documentElement.setAttribute("data-sidebar-text", "xl")
  );
  const grown = await repoRow.evaluate((el) => el.getBoundingClientRect().height);
  expect(grown).toBeGreaterThan(repoHeight);
});

test("every lens shares one left edge — the Pinned grip must not indent its rows", async () => {
  sandbox = createGitSandbox();
  for (const name of ["alpha", "bravo"]) sandbox.makeRepo(name);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(2, {
    timeout: 20_000
  });
  const nameLeft = async (): Promise<number> =>
    window
      .locator(".repo-row__name", { hasText: "alpha" })
      .evaluate((el) => el.getBoundingClientRect().left);
  const allLeft = await nameLeft();

  // Pin both and switch lens. The Pinned lens renders a drag grip that the
  // others don't; it is invisible at rest, but it used to be an in-flow flex
  // child, so it shifted every Pinned row's content right by its width and the
  // list read as indented next to Recent. Out of flow, the edges agree.
  for (const name of ["alpha", "bravo"]) {
    await window.locator(".repo-row", { hasText: name }).locator(".pin").click();
  }
  await lensChip(window, "Pinned").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(2);
  const pinnedLeft = await nameLeft();
  expect(Math.abs(pinnedLeft - allLeft)).toBeLessThanOrEqual(0.5);
});
