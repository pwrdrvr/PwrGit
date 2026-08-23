import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { lensChip } from "./fixtures/steps";

// One window per profile: creating/picking a profile opens (or focuses) its
// own window — it never repoints the window you're in.
let boxA: GitSandbox | null = null;
let boxB: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  boxA?.cleanup();
  boxB?.cleanup();
  boxA = null;
  boxB = null;
});

test("creating a profile opens its own window with repos from all roots", async () => {
  boxA = createGitSandbox();
  boxA.makeRepo("acme-svc");
  boxB = createGitSandbox();
  boxB.makeRepo("pwr-svc");

  handle = await launchApp();
  const { window } = handle;

  // Open the profile menu → New profile.
  await window.locator(".profile-chip").click();
  await window.locator(".profile-menu__action", { hasText: "New profile" }).click();

  // Fill identity.
  // Full placeholder — the shorter "e.g. Acme" also matches "e.g. acme-inc"
  // (placeholder matching is case-insensitive), tripping strict mode.
  await window.getByPlaceholder("e.g. Acme or Personal").fill("Acme");
  await window.getByPlaceholder("you@company.com").fill("harold@acme.dev");

  // Add both folders in one native dialog.
  await handle.setPickDirectories([boxA.reposDir, boxB.reposDir]);
  await window.locator(".modal--profile .rootlist__add").click();
  await expect(window.locator(".modal--profile .rootlist__item")).toHaveCount(2);

  // Creating opens a NEW window bound to the new profile.
  const windowPromise = handle.app.waitForEvent("window");
  await window.locator(".modal--profile .modal__create").click();
  const acmeWindow = await windowPromise;
  await acmeWindow.waitForSelector("#root");

  await expect(acmeWindow.locator(".profile-chip__name")).toHaveText("Acme", {
    timeout: 20_000
  });
  // The original window keeps ITS profile — no in-window switching. (The
  // seed is named "Personal" now — a workspace label, not the git identity.)
  await expect(window.locator(".profile-chip__name")).toHaveText("Personal");

  // The new window lists repos from BOTH roots.
  await lensChip(acmeWindow, "All").click();
  await expect(
    acmeWindow.locator(".repo-row__name", { hasText: "acme-svc" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    acmeWindow.locator(".repo-row__name", { hasText: "pwr-svc" })
  ).toBeVisible();

  // At the supported minimum sidebar width, every lens label remains intact
  // beside the display-options trigger.
  const sidebarResizer = acmeWindow.getByRole("separator", {
    name: "Resize sidebar"
  });
  await sidebarResizer.focus();
  for (let i = 0; i < 5; i += 1) {
    await sidebarResizer.press("ArrowLeft");
  }
  await expect(sidebarResizer).toHaveAttribute("aria-valuenow", "240");
  const lensWidths = await acmeWindow.locator(".lens-chip").evaluateAll((chips) =>
    chips.map((chip) => ({
      // The chips are icon-only, so their name is the accessible one — reading
      // textContent here would label every failure "unknown".
      label: chip.getAttribute("aria-label") ?? "unknown",
      available: chip.clientWidth,
      required: chip.scrollWidth
    }))
  );
  for (const width of lensWidths) {
    expect(width.required, `${width.label} lens width`).toBeLessThanOrEqual(
      width.available
    );
  }

  // Group-by-folder is the default, and its folder headers stay pinned to the
  // sidebar scrollport while repositories pass underneath.
  await expect(acmeWindow.locator(".repo-group")).toHaveCount(2);
  const firstGroupHead = acmeWindow.locator(".repo-group__head").first();
  await expect(firstGroupHead).toHaveCSS("position", "sticky");

  const sidebarList = acmeWindow.locator(".sidebar__list");
  await sidebarList.evaluate((element) => {
    element.style.flex = "0 0 72px";
    element.scrollTop = 20;
  });
  await expect
    .poll(async () => {
      const listBox = await sidebarList.boundingBox();
      const headBox = await firstGroupHead.boundingBox();
      if (listBox === null || headBox === null) return Number.NaN;
      return Math.round(headBox.y - listBox.y);
    })
    .toBe(0);

  // The grouping preference moved into the compact kebab beside the lenses.
  const optionsButton = acmeWindow.getByRole("button", {
    name: "Sidebar display options"
  });
  await optionsButton.click();
  await expect(optionsButton).toHaveAttribute("aria-expanded", "true");
  await optionsButton.click();
  await expect(optionsButton).toHaveAttribute("aria-expanded", "false");
  await expect(
    acmeWindow.getByRole("menu", { name: "Sidebar display options" })
  ).toHaveCount(0);

  await optionsButton.click();
  await acmeWindow.getByRole("menuitem", { name: /Group by folder/ }).click();
  await expect(acmeWindow.locator(".repo-group")).toHaveCount(0);

  // Picking the profile again anywhere focuses the existing window — never a
  // third one. (Drive it from the original window's menu.)
  await window.locator(".profile-chip").click();
  await window
    .locator(".profile-menu__item", { hasText: "Acme" })
    .click();
  await window.waitForTimeout(600);
  expect(handle.app.windows().length).toBe(2);
});

test("a profile can override the app theme and return to inheritance live", async () => {
  handle = await launchApp({ theme: "dark" });
  const { app, window: mainWindow } = handle;

  await mainWindow.locator(".profile-chip").click();
  await mainWindow
    .locator(".profile-menu__action", { hasText: "New profile" })
    .click();
  const modal = mainWindow.locator(".modal--profile");
  await modal.getByPlaceholder("e.g. Acme or Personal").fill("Light workspace");
  await modal.getByPlaceholder("you@company.com").fill("light@example.com");
  await modal.getByRole("radio", { name: "Light" }).click();

  const windowPromise = app.waitForEvent("window");
  await modal.locator(".modal__create").click();
  const lightWindow = await windowPromise;
  await lightWindow.waitForSelector("#root");

  await expect(lightWindow.locator("html")).toHaveAttribute(
    "data-theme",
    "light"
  );
  await expect(mainWindow.locator("html")).not.toHaveAttribute(
    "data-theme",
    "light"
  );
  expect(
    await lightWindow.evaluate(() => window.pwrgit.appearance)
  ).toEqual({ theme: "light", resolvedTheme: "light" });

  const lightTitle = await lightWindow.title();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }, title) => {
        const target = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === title
        );
        return target?.getBackgroundColor() ?? null;
      }, lightTitle)
    )
    .toBe("#FFFFFF");

  await lightWindow.locator(".profile-chip").click();
  await lightWindow
    .locator(".profile-menu__action", { hasText: "Edit “Light workspace”…" })
    .click();
  const editModal = lightWindow.locator(".modal--profile");
  await editModal.getByRole("radio", { name: "App setting" }).click();
  await editModal.locator(".modal__create").click();

  await expect(lightWindow.locator("html")).not.toHaveAttribute(
    "data-theme",
    "light"
  );
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }, title) => {
        const target = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === title
        );
        return target?.getBackgroundColor() ?? null;
      }, lightTitle)
    )
    .toBe("#000000");
});

test("profile menu closes on outside click and Escape", async () => {
  handle = await launchApp();
  const { window } = handle;

  await window.locator(".profile-chip").click();
  await expect(window.locator(".profile-menu")).toBeVisible();

  // Click anywhere else — the full-viewport backdrop is what an outside click
  // lands on now, and it closes the menu.
  await window
    .locator(".profile-menu__backdrop")
    .click({ position: { x: 600, y: 400 } });
  await expect(window.locator(".profile-menu")).toHaveCount(0);

  // Escape closes it too.
  await window.locator(".profile-chip").click();
  await expect(window.locator(".profile-menu")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.locator(".profile-menu")).toHaveCount(0);
});

test("a cross-profile remote branch opens its new-worktree flow in the owning window", async () => {
  boxA = createGitSandbox();
  const repo = boxA.makeRepoBehindRemote("remote-profile");
  repo.createBranch("releases/1.0");
  boxA.git(repo.path, "push", "origin", "releases/1.0");
  boxA.git(repo.path, "branch", "-D", "releases/1.0");

  handle = await launchApp({ worktreeRoot: boxA.worktreeRoot });
  const { window } = handle;
  await window.locator(".profile-chip").click();
  await window.locator(".profile-menu__action", { hasText: "New profile" }).click();
  await window.getByPlaceholder("e.g. Acme or Personal").fill("Remote team");
  await window.getByPlaceholder("you@company.com").fill("remote@example.com");
  await handle.setPickDirectory(boxA.reposDir);
  await window.locator(".modal--profile .rootlist__add").click();
  const windowPromise = handle.app.waitForEvent("window");
  await window.locator(".modal--profile .modal__create").click();
  const remoteWindow = await windowPromise;
  await remoteWindow.waitForSelector("#root");
  await lensChip(remoteWindow, "All").click();
  await expect(
    remoteWindow.locator(".repo-row__name", { hasText: "remote-profile" })
  ).toBeVisible({ timeout: 20_000 });

  await window.keyboard.press("Meta+k");
  await window.locator(".overlay-search input").fill("releases/1.0");
  const release = window.locator(".overlay-result", {
    hasText: "releases/1.0"
  });
  await expect(release).toBeVisible({ timeout: 20_000 });
  await release.click();

  const modal = remoteWindow.locator(".modal", {
    hasText: "New worktree · remote-profile"
  });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".modal__input")).toHaveValue("releases/1.0");
  await expect(modal).toContainText(
    "Starting from refs/remotes/origin/releases/1.0"
  );
});
