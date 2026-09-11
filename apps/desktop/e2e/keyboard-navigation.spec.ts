import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

/**
 * The keyboard contract every overlay in the app now shares, checked against a
 * real browser because all of it is focus behaviour that jsdom cannot model:
 * what `:focus-visible` matches, where Tab actually goes, and whether a control
 * is reachable at all.
 *
 * The unit tests in `src/renderer/src/lib/*.test.ts` cover the hooks in
 * isolation. What lands here is the wiring — that a given surface is on the
 * hook at all, which is precisely what was missing before.
 */

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

test("a popup menu takes the arrows, and Escape returns focus to its trigger", async () => {
  handle = await launchApp();
  const { window } = handle;

  const chip = window.locator(".profile-chip");
  await chip.click();
  const menu = window.locator(".profile-menu");
  await expect(menu).toBeVisible();

  // Focus enters the menu on open, so the arrows have somewhere to start —
  // before this the menu was a dead end for anyone not using a mouse.
  const items = window.locator(".profile-menu__item, .profile-menu__action");
  await expect(items.first()).toBeFocused();

  // Roving tabindex: exactly one item is in the tab order at a time, which is
  // what keeps the whole menu a single tab stop.
  expect(await items.evaluateAll((els) =>
    els.filter((el) => (el as HTMLElement).tabIndex === 0).length
  )).toBe(1);

  await window.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await window.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await window.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  // Wrapping: up from the top lands on the bottom.
  await window.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();

  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test("the branch navigator can be dismissed from the keyboard at all", async () => {
  // It had no Escape path whatsoever: clicking its backdrop was the only way
  // out (WCAG 2.1 SC 2.1.1).
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha");
  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  const trigger = window.locator(".graph-branches");
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();

  const pop = window.locator(".branch-pop");
  await expect(pop).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  await window.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("a dialog keeps Tab inside it and hands focus back on close", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("beta");
  handle = await launchApp({ worktreeRoot: sandbox.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "beta");

  const opener = window.getByRole("button", { name: /New worktree/i });
  await opener.click();

  const modal = window.locator(".modal");
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("aria-modal", "true");

  // Tab many more times than the dialog has controls. Without a trap this
  // walks out into the sidebar behind it, where a keyboard user can operate
  // things the dialog is supposedly covering (SC 2.4.3).
  for (let i = 0; i < 12; i++) await window.keyboard.press("Tab");
  expect(
    await modal.evaluate((el) => el.contains(document.activeElement))
  ).toBe(true);

  // Shift+Tab out of the front edge wraps to the back, rather than escaping.
  for (let i = 0; i < 12; i++) await window.keyboard.press("Shift+Tab");
  expect(
    await modal.evaluate((el) => el.contains(document.activeElement))
  ).toBe(true);

  await window.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  // This dialog autoFocuses its field, which React applies during commit —
  // before effects run. A hook that reads the opener in an effect records that
  // field instead and restores nothing on close.
  await expect(opener).toBeFocused();
});

test("a dialog that was unclosable by keyboard now closes", async () => {
  // ProfileModal had no Escape handler of any kind: once open, a keyboard-only
  // user had no way out of it.
  handle = await launchApp();
  const { window } = handle;

  await window.locator(".profile-chip").click();
  await window
    .locator(".profile-menu__action", { hasText: "New profile" })
    .click();

  const modal = window.locator(".modal--profile");
  await expect(modal).toBeVisible();

  await window.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("a menu that launches a dialog hands the key over cleanly", async () => {
  // Not the nested case — the menu closes as it opens the dialog, so only one
  // overlay is ever registered here. What this pins is the handover: the menu's
  // layer is unregistered rather than left behind, so the dialog (not a stale
  // menu entry) answers the next Escape, and exactly one overlay closes.
  //
  // Stacked overlays are covered where they can actually be constructed:
  // useDismissable.test.ts builds a real nested pair, and DiffViewer.test.tsx
  // covers a ContextMenu open over the diff pane and over the lightbox.
  handle = await launchApp();
  const { window } = handle;

  await window.locator(".profile-chip").click();
  await window
    .locator(".profile-menu__action", { hasText: "New profile" })
    .click();
  await expect(window.locator(".modal--profile")).toBeVisible();
  await expect(window.locator(".profile-menu")).toHaveCount(0);

  await window.keyboard.press("Escape");
  await expect(window.locator(".modal--profile")).toHaveCount(0);
  // One press closed one thing: the sidebar behind it is untouched.
  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(window.locator(".profile-chip")).toBeVisible();
});
