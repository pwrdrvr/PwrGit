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

  // Day one: the empty list carries Add folders, and Clone stays discoverable
  // in the Add menu with its prerequisite spelled out rather than hidden.
  await expect(toolbar).toBeVisible();
  await expect(
    window.locator(".sidebar__start").getByRole("button", { name: "Add folders…" })
  ).toBeEnabled();
  await expect(
    window.getByText("Clone and Fork, under Add, open once a folder exists.")
  ).toBeVisible();
  await add.click();
  const clone = window.getByRole("menuitem", { name: /^Clone…/ });
  await expect(clone).toBeDisabled();
  // The reason is the menu's own hint line, so it is part of the item's
  // name as well as on screen.
  await expect(clone).toContainText("Add a repo folder before cloning");
  await window.keyboard.press("Escape");
  await expect(window.getByRole("menu")).toHaveCount(0);

  await addRootAndExpand(window, handle, sandbox, repo.name);
  // The day-one card leaves once a folder exists.
  await expect(window.locator(".sidebar__start")).toHaveCount(0);
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
    const buttons = [...row.querySelectorAll("button")].map((button) =>
      button.getBoundingClientRect()
    );
    return {
      count: buttons.length,
      tops: [...new Set(buttons.map((box) => Math.round(box.top)))],
      heights: [...new Set(buttons.map((box) => Math.round(box.height)))],
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
