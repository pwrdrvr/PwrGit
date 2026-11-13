import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

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

test("the toolbar is one row and stays put above a long scrolling repo list", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("clone-action-fixture");
  for (let index = 0; index < 20; index += 1) {
    repo.addWorktree(`padding/worktree-${String(index).padStart(2, "0")}`);
  }

  handle = await launchApp();
  const { app, window } = handle;
  const toolbar = window.getByRole("group", { name: "Repositories", exact: true });
  const add = toolbar.getByRole("button", { name: "Add repositories" });

  // Day one: the main pane's start screen carries the doors, and the empty
  // list steps back to one line (design/New User Journey - UX Review, 4a).
  // Clone needs no folder first: its destination step can create one (5a).
  // Only Rescan still waits for a folder, with the reason spelled out.
  await expect(toolbar).toBeVisible();
  const start = window.getByTestId("start-screen");
  await expect(start.getByRole("button", { name: /^Add folders…/ })).toBeEnabled();
  await expect(start.getByRole("button", { name: /^Find my repositories/ })).toBeEnabled();
  await expect(window.locator(".sidebar__empty")).toHaveText("No repositories yet.");
  await add.click();
  await expect(window.getByRole("menuitem", { name: /^Find repositories…/ })).toBeEnabled();
  await expect(window.getByRole("menuitem", { name: /^Clone…/ })).toBeEnabled();
  const rescan = window.getByRole("menuitem", { name: /^Rescan folders/ });
  await expect(rescan).toBeDisabled();
  // The reason is the menu's own hint line, so it is part of the item's
  // name as well as on screen.
  await expect(rescan).toContainText("Add a repo folder first");
  await window.keyboard.press("Escape");
  await expect(window.getByRole("menu")).toHaveCount(0);

  await addRootAndExpand(window, handle, sandbox, repo.name);
  // The start screen leaves once the profile has a repository.
  await expect(window.getByTestId("start-screen")).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1360, 620);
  });
  await expect
    .poll(() =>
      window.evaluate(() => document.documentElement.clientHeight)
    )
    .toBeLessThanOrEqual(620);

  // One row: Add, the sync button and the wrench share a top edge and a
  // height, and the row is no taller than one button plus its padding. This is
  // what replaced five rows in four styles (design/Sidebar Header Toolbar -
  // UX Review.dc.html, 2b).
  const geometry = await window.evaluate(() => {
    const row = document.querySelector(".sidebar-toolbar");
    if (row === null) throw new Error("missing .sidebar-toolbar");
    // Measure what is drawn: the row's own children. The sync button is one
    // bordered box (`.sidebar-toolbar__split`) whose two halves sit inside
    // its border, so their boxes are 1px in from Add's and the wrench's.
    const boxes = [...row.children]
      .filter((child) => child instanceof HTMLElement && child.offsetParent !== null)
      .map((child) => child.getBoundingClientRect());
    return {
      count: row.querySelectorAll("button").length,
      tops: [...new Set(boxes.map((box) => Math.round(box.top)))],
      heights: [...new Set(boxes.map((box) => Math.round(box.height)))],
      rowHeight: Math.round(row.getBoundingClientRect().height)
    };
  });
  // Four buttons: Add, the sync button's face and its chevron ("Sync
  // options", two buttons drawn as one; Pull is a choice on it), and the
  // wrench. design/Fetch Toast and Scope - UX Review.dc.html, turn 5.
  expect(geometry.count).toBe(4);
  expect(geometry.tops).toHaveLength(1);
  expect(geometry.heights).toHaveLength(1);
  expect(geometry.rowHeight).toBeLessThanOrEqual(
    (geometry.heights[0] ?? 0) + 24
  );

  await expect(add).toBeInViewport();
  const beforeScroll = await add.boundingBox();
  await window.locator(".sidebar__list").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(add).toBeInViewport();
  const afterScroll = await add.boundingBox();
  expect(afterScroll?.y).toBe(beforeScroll?.y);

  await add.click();
  await expect(window.getByRole("menuitem", { name: "Clone…" })).toBeEnabled();
  await window.getByRole("menuitem", { name: "Clone…" }).click();
  await expect(
    window.getByRole("dialog", { name: "Clone a repository" })
  ).toBeVisible();
});
