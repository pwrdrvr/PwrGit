import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  lensChip,
  primaryShortcut,
  repoGroup
} from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  await handle?.cleanup();
  handle = null;
  sandbox?.cleanup();
  sandbox = null;
});

test("renderer affordances follow the real OS platform", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("alpha", {
    worktrees: ["feature/one", "feature/two"]
  });
  handle = await launchApp();
  const { window } = handle;

  const platform = await window.evaluate(
    () =>
      (globalThis as typeof globalThis & { pwrgit: { platform: string } })
        .pwrgit.platform
  );
  expect(platform).toBe(process.platform);
  const shortcut = (key: string): string =>
    platform === "darwin" ? `⌘${key}` : `Ctrl+${key}`;
  const reorder =
    platform === "darwin"
      ? "⇧⌘↑ / ⇧⌘↓"
      : "Ctrl+Shift+↑ / Ctrl+Shift+↓";
  const reveal =
    platform === "darwin"
      ? "Reveal in Finder"
      : platform === "win32"
        ? "Show in Explorer"
        : "Show in folder";

  const searchHint = window.locator(".sidebar__search .kbd");
  await expect(searchHint).toHaveText(shortcut("F"));
  await expect(searchHint).toHaveAttribute(
    "title",
    `${shortcut("F")} or ${shortcut("K")}`
  );

  // Drive the advertised chord, not a Mac-only Meta alias. This executes as
  // Control+F in the Windows E2E job and proves the label still names behavior.
  await window.keyboard.press(primaryShortcut("F"));
  await expect(
    window.getByRole("dialog", { name: "Jump to repo, branch, or commit" })
  ).toBeVisible();
  await window.keyboard.press("Escape");

  await addRootAndExpand(window, handle, sandbox, "alpha");

  const parts = repo.path.split(/[\\/]+/).filter(Boolean);
  const expectedTail = parts
    .slice(-2)
    .join(platform === "win32" ? "\\" : "/");
  await expect(window.locator(".titlebar__pathchip")).toContainText(expectedTail);

  const linked = branchRow(window, "feature/one");
  await expect(linked.locator(".wt-row__handle")).toHaveAttribute(
    "title",
    `Drag to reorder — or ${reorder} from the keyboard`
  );

  // The Windows chord is Control+Shift+Down. Keep the action behind the copy:
  // the focused row moves and announces just as Command does on macOS.
  await linked.focus();
  await window.keyboard.press(primaryShortcut("Shift", "ArrowDown"));
  await expect(window.locator("#pwrgit-live-region")).toContainText(
    "feature/one moved"
  );

  await linked.click({ button: "right" });
  await expect(window.getByRole("menuitem", { name: reveal })).toBeVisible();
  await window.keyboard.press("Escape");

  // Repo grips only exist in the user-arranged Pinned lens.
  await repoGroup(window, "alpha")
    .getByRole("button", { name: "Pin repo" })
    .click();
  await lensChip(window, "Pinned").click();
  await expect(repoGroup(window, "alpha").locator(".repo-row__handle"))
    .toHaveAttribute(
      "title",
      `Drag to reorder — or ${reorder} from the keyboard`
    );

  await window.keyboard.press(primaryShortcut("F"));
  const search = window.getByRole("dialog", {
    name: "Jump to repo, branch, or commit"
  });
  await search.getByRole("textbox").fill("alpha");
  await expect(search.locator(".overlay-foot")).toContainText(
    `${shortcut("P")} pin`
  );
});
