import { expect, test, type Page } from "@playwright/test";
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

const repoNames = (window: Page): Promise<string[]> =>
  window.locator(".repo-row__name").allTextContents();

/** Three pinned repos, shown in the Pinned lens in name order. */
async function pinnedSandbox(): Promise<Page> {
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

  // Pin all three from the All lens, where the star is always shown.
  for (const name of ["alpha", "bravo", "charlie"]) {
    await window
      .locator(".repo-row", { hasText: name })
      .locator(".pin")
      .click();
  }
  await window.locator(".lens-chip", { hasText: "Pinned" }).click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);
  expect(await repoNames(window)).toEqual(["alpha", "bravo", "charlie"]);
  return window;
}

test("dragging a pinned repo to the end of the list reorders it", async () => {
  const window = await pinnedSandbox();

  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  const charlie = window.locator(".repo-row", { hasText: "charlie" });
  const box = await charlie.boundingBox();
  if (box === null) throw new Error("charlie row has no box");

  // Aim at charlie's LOWER half — the "after" position. Before the drop
  // gained a position, no gesture could put a row past the last one.
  await alpha.hover();
  await window.mouse.down();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, {
    steps: 12
  });

  // Mid-drag: the source is dimmed and the insertion line is under charlie.
  await expect(alpha).toHaveClass(/is-dragging/);
  await expect(charlie).toHaveClass(/is-drop-after/);
  await window
    .locator(".sidebar__list")
    .screenshot({ path: test.info().outputPath("mid-drag-insertion-line.png") });

  await window.mouse.up();

  expect(await repoNames(window)).toEqual(["bravo", "charlie", "alpha"]);

  // Let the star fade settle before capturing. The 120ms transition otherwise
  // lands in the screenshot as a half-lit star on a row nothing is pointing at,
  // which reads as a bug in the artifact when it is only a frame mid-fade.
  await expect(
    window.locator(".repo-row", { hasText: "charlie" }).locator(".pin")
  ).toHaveCSS("opacity", "0");
  await window
    .locator(".sidebar__list")
    .screenshot({ path: test.info().outputPath("after-drop.png") });
});

test("dragging a repo row selects no text", async () => {
  const window = await pinnedSandbox();

  // The original complaint: a drag in the sidebar painted a text selection
  // across every row it crossed instead of moving anything.
  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  const charlie = window.locator(".repo-row", { hasText: "charlie" });
  const box = await charlie.boundingBox();
  if (box === null) throw new Error("charlie row has no box");

  await alpha.hover();
  await window.mouse.down();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, {
    steps: 12
  });
  // `document.getSelection`, not `window.getSelection` — `window` here is the
  // Playwright Page, not the page's global object.
  const selected = await window.evaluate(() =>
    (document.getSelection()?.toString() ?? "").trim()
  );
  await window.mouse.up();

  expect(selected).toBe("");
});

test("⌘⇧↓ moves a pinned repo without the mouse", async () => {
  const window = await pinnedSandbox();

  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  await alpha.focus();
  await window.keyboard.press("Meta+Shift+ArrowDown");

  expect(await repoNames(window)).toEqual(["bravo", "alpha", "charlie"]);

  // And the row keeps focus, so a second press keeps moving the same repo
  // rather than whatever slid into the vacated slot.
  await window.keyboard.press("Meta+Shift+ArrowDown");
  expect(await repoNames(window)).toEqual(["bravo", "charlie", "alpha"]);
});

test("the computed lenses stay computed — no drag handle outside Pinned", async () => {
  const window = await pinnedSandbox();
  await expect(
    window.locator(".repo-row").first()
  ).toHaveClass(/is-arrangeable/);

  await window.locator(".lens-chip", { hasText: "All" }).click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);
  await expect(window.locator(".repo-row.is-arrangeable")).toHaveCount(0);
  await expect(window.locator(".repo-row__handle")).toHaveCount(0);
});
