import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow, lensChip } from "./fixtures/steps";

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
  await lensChip(window, "All").click();
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
  await lensChip(window, "Pinned").click();
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

  // The pinned state remains visible after the drag; wait for that state before
  // capturing so the screenshot also covers the persistent star treatment.
  const charliePin = window
    .locator(".repo-row", { hasText: "charlie" })
    .locator(".pin");
  await expect(charliePin).toHaveCSS("opacity", "1");
  await expect(charliePin).toHaveAttribute("aria-pressed", "true");
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

  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);
  await expect(window.locator(".repo-row.is-arrangeable")).toHaveCount(0);
  await expect(window.locator(".repo-row__handle")).toHaveCount(0);
});

test("the sidebar tree exposes valid, nested roles", async () => {
  const window = await pinnedSandbox();

  // Repo rows are treeitems at level 1 inside the tree — not `option`, which
  // only means anything inside a listbox.
  const tree = window.locator('.sidebar__list[role="tree"]');
  await expect(tree).toHaveCount(1);
  await expect(tree.locator('.repo-row[role="treeitem"]')).toHaveCount(3);
  await expect(window.locator('[role="option"]')).toHaveCount(0);

  // Expanding a repo adds a group of level-2 treeitems, owned by the repo row
  // (the section is a DOM sibling, so ownership is explicit via aria-owns).
  await window.locator(".repo-row", { hasText: "alpha" }).click();
  const group = window.locator('.wt-section[role="group"]');
  await expect(group).toHaveCount(1);
  await expect(group.locator('.wt-row[role="treeitem"]')).not.toHaveCount(0);
  const owns = await window
    .locator(".repo-row", { hasText: "alpha" })
    .getAttribute("aria-owns");
  expect(owns).toBe(await group.getAttribute("id"));
});

test("the via-wt marker appears only in the lens whose claim it makes", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("solo", { worktrees: ["feature/login"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "solo");

  // Pin a WORKTREE, not the repo: that pulls the repo into the Pinned lens
  // while the repo's own star stays unlit, which is what the marker explains.
  // The pin lives in the hover-gated action cluster (`pointer-events: none` at
  // rest), so the row has to be hovered before the click is actionable — and
  // re-hovered inside the retry, since a background repo refresh can re-render
  // the row and eat the :hover state.
  const wtRow = branchRow(window, "feature/login");
  await expect(async () => {
    await wtRow.hover();
    await wtRow
      .getByRole("button", { name: "Pin worktree" })
      .click({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(wtRow.getByRole("button", { name: "Unpin worktree" })).toHaveCount(1);

  // In All, the repo is not "in Pinned", so the marker must not claim it is.
  await expect(window.locator(".repo-row__pin-via")).toHaveCount(0);

  await lensChip(window, "Pinned").click();
  await expect(window.locator(".repo-row__pin-via")).toHaveCount(1);
});
