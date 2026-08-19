import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

// The Settings window is a singleton aux window on the `#settings` hash route,
// opened from the app menu (Settings…, CmdOrCtrl+,). It is not profile-bound:
// the Profiles pane manages every profile; Experimental/Diagnostics write
// app-level settings that round-trip through settings:update.
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
});

/** Click the Settings… item in the application menu (macOS: app menu;
 *  elsewhere: File). Playwright can't drive native menus, so invoke the
 *  item's click handler from the main process. */
async function openSettingsFromMenu(app: AppHandle["app"]): Promise<void> {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      for (const item of top.submenu?.items ?? []) {
        if (item.label === "Settings…") {
          item.click();
          return;
        }
      }
    }
    throw new Error("Settings… menu item not found");
  });
}

/** Wrap main's `fetch` so a spec can prove the UI made no network call.
 *  e2e launches are unpackaged, and an unpackaged build must never spend one
 *  of the 60 anonymous GitHub requests per hour this machine's IP gets. */
async function recordMainFetches(app: AppHandle["app"]): Promise<void> {
  await app.evaluate(() => {
    const scope = globalThis as unknown as {
      __fetchedUrls?: string[];
      fetch: typeof fetch;
    };
    scope.__fetchedUrls = [];
    const original = scope.fetch;
    scope.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      scope.__fetchedUrls?.push(
        typeof input === "string" ? input : String((input as Request).url ?? input)
      );
      return original(input, init);
    }) as typeof fetch;
  });
}

async function mainFetchedUrls(app: AppHandle["app"]): Promise<string[]> {
  const recorded = await app.evaluate(
    () => (globalThis as unknown as { __fetchedUrls?: string[] }).__fetchedUrls
  );
  // Never fall back to an empty list: that would let this guard "pass" by
  // recording nothing at all, which is exactly the state it exists to catch.
  expect(
    Array.isArray(recorded),
    "fetch recorder was not installed in main — this assertion proves nothing"
  ).toBe(true);
  return recorded as string[];
}

test("menu opens the Settings window; panes render and settings persist", async () => {
  handle = await launchApp();
  const { app } = handle;
  await recordMainFetches(app);

  const settingsWindowPromise = app.waitForEvent("window");
  await openSettingsFromMenu(app);
  const settings = await settingsWindowPromise;
  await settings.waitForSelector(".settings-screen");

  // General is the landing section. Developer Mode starts off — the View
  // menu carries no Electron developer items.
  const viewMenuLabels = () =>
    app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find(
        (item) => item.label === "View"
      );
      return (view?.submenu?.items ?? []).map((item) => item.label);
    });
  expect(await viewMenuLabels()).not.toContain("Toggle Developer Tools");
  const devModeSwitch = settings.getByRole("switch", {
    name: "Developer Mode"
  });
  await devModeSwitch.click();
  await expect(devModeSwitch).toHaveAttribute("aria-checked", "true");
  // The menu rebuilds live with Reload / Force Reload / Toggle DevTools.
  expect(await viewMenuLabels()).toContain("Toggle Developer Tools");

  // Profiles pane — the seeded profile is listed and marked active.
  await settings
    .locator(".settings-nav__button", { hasText: "Profiles" })
    .click();
  const personalRow = settings
    .locator(".settings-profile-row", { hasText: "Personal" });
  await expect(personalRow).toBeVisible();
  await expect(personalRow.locator(".settings-card__chip--ok")).toHaveText(
    "Active"
  );

  // Updates: picking a train persists both keys so a later Beta binary
  // cannot re-infer after the operator chose Stable.
  await settings.locator(".settings-nav__button", { hasText: "Updates" }).click();
  await expect(
    settings.getByRole("radio", { name: "Stable" })
  ).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("radio", { name: "Beta" }).click();
  await expect(
    settings.getByRole("radio", { name: "Beta" })
  ).toHaveAttribute("aria-checked", "true");

  // Mounting the pane must not check GitHub for release versions: this build
  // is unpackaged and could not install what it found anyway.
  expect(
    (await mainFetchedUrls(app)).filter(
      (url) => url.includes("api.github.com") && url.includes("/releases")
    )
  ).toEqual([]);

  // Forges: real status from main's probe. Which forges are logged in varies
  // by machine, so assert the pane resolved to a real state rather than a
  // particular one — the point is that it consumes forge:status at all.
  await settings.locator(".settings-nav__button", { hasText: "Forges" }).click();
  const forgePanel = settings.locator("section[aria-label='Forges']");
  await expect(forgePanel).toBeVisible();
  await expect(forgePanel).toContainText("GitHub");
  await expect(forgePanel).toContainText("GitLab");
  await expect(forgePanel.locator(".settings-card__chip").first()).not.toHaveText(
    "Probing"
  );

  // Experimental: the lineage-scope toggle round-trips through
  // settings:update (button state comes from the returned snapshot).
  await settings
    .locator(".settings-nav__button", { hasText: "Experimental" })
    .click();
  const lineageSwitch = settings.getByRole("switch", {
    name: "Default to all branches"
  });
  await expect(lineageSwitch).toHaveAttribute("aria-checked", "false");
  await lineageSwitch.click();
  await expect(lineageSwitch).toHaveAttribute("aria-checked", "true");

  // Memory / CPU: arming hot CPU capture enables its dependent controls.
  await settings
    .locator(".settings-nav__button", { hasText: "Memory / CPU" })
    .click();
  const armSwitch = settings.getByRole("switch", {
    name: "Arm hot CPU capture"
  });
  const heapSnapshotSwitch = settings.getByRole("switch", {
    name: "Heap snapshots during profiles"
  });
  await expect(heapSnapshotSwitch).toBeDisabled();
  await armSwitch.click();
  await expect(armSwitch).toHaveAttribute("aria-checked", "true");
  await expect(heapSnapshotSwitch).toBeEnabled();

  // All writes landed in one settings.json (sparse storage) — read it from
  // the test process (evaluate can't dynamic-import node modules).
  const userData = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData")
  );
  const stored = JSON.parse(
    readFileSync(join(userData, "settings.json"), "utf8")
  ) as Record<string, unknown>;
  expect(stored["general"]).toEqual({ developerMode: true });
  expect(stored["updates"]).toEqual({ train: "beta", channel: "latest" });
  expect(stored["experimental"]).toEqual({ lineageAllBranches: true });
  expect(stored["diagnostics"]).toEqual({ hotCpuProfilingEnabled: true });

  // Singleton: reopening from the menu focuses the same window.
  await openSettingsFromMenu(app);
  expect(app.windows().length).toBe(2);
});
