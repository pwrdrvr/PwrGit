import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FORGE_KINDS, forgeProduct } from "@pwrgit/shared";
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

  // Dark is the safe migration default. Theme changes repaint every renderer
  // plus Electron-owned/native chrome, and System delegates back to the OS.
  await expect(settings.getByRole("radio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await settings.getByRole("radio", { name: "System" }).click();
  await expect.poll(async () =>
    app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
  ).toBe("system");
  // Electron can publish the resolved OS scheme just after themeSource flips;
  // poll the renderer/native pair rather than pinning that transient value.
  await expect
    .poll(async () => {
      const [systemUsesDark, dataTheme] = await Promise.all([
        app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors),
        settings.locator("html").getAttribute("data-theme")
      ]);
      return systemUsesDark ? dataTheme === null : dataTheme === "light";
    })
    .toBe(true);
  await settings.getByRole("radio", { name: "Light" }).click();
  await expect(settings.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(handle.window.locator("html")).toHaveAttribute(
    "data-theme",
    "light"
  );
  await expect.poll(async () =>
    app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
  ).toBe("light");

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
  const platform = await settings.evaluate(() => window.pwrgit.platform);
  const shortcutCopy =
    platform === "darwin"
      ? "Also enables their shortcuts (⌘R, ⇧⌘R, ⌥⌘I). Takes effect immediately in every window."
      : "Also enables their shortcuts (Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I). Takes effect immediately in every window.";
  await expect(
    settings.locator(".settings-field", { hasText: "Developer Mode" })
  ).toContainText(shortcutCopy);
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

  // Updates: all four published slots are on screen, and picking one persists
  // both axes plus the pin, so a later Beta binary cannot re-infer past it.
  // Tiles are addressed by the aria-label prefix — the version half settles
  // from "Loading…" to whatever the slot resolved to.
  await settings.locator(".settings-nav__button", { hasText: "Updates" }).click();
  const slot = (train: string, channel: string) =>
    settings.locator(`.settings-slot[aria-label^="${train} ${channel} "]`);
  await expect(settings.locator(".settings-slot")).toHaveCount(4);
  await expect(slot("Stable", "Latest")).toHaveAttribute(
    "aria-checked",
    "true"
  );
  // An unpackaged build fetches nothing, so every slot is empty — and each
  // one says why on itself instead of leaving a blank tile.
  await expect(slot("Beta", "Prerelease")).toContainText(
    "Release versions are not fetched in development builds."
  );
  await slot("Beta", "Latest").click();
  await expect(slot("Beta", "Latest")).toHaveAttribute("aria-checked", "true");
  await expect(slot("Stable", "Latest")).toHaveAttribute(
    "aria-checked",
    "false"
  );

  // Mounting the pane must not check GitHub for release versions: this build
  // is unpackaged and could not install what it found anyway.
  expect(
    (await mainFetchedUrls(app)).filter(
      (url) => url.includes("api.github.com") && url.includes("/releases")
    )
  ).toEqual([]);

  // Forges: one section per product, each from main's probe. Which forges are
  // logged in varies by machine, so assert each pane resolved to a real state
  // rather than a particular one — the point is that it consumes forge:status
  // and forge:hosts at all.
  await settings.locator(".settings-nav__button", { hasText: "Forges" }).click();
  // Driven from the product list rather than a pair written here, so this is
  // the assertion that a third registry entry gets a section in the running
  // app — not just in the unit test that renders the pane.
  for (const kind of FORGE_KINDS) {
    const product = forgeProduct(kind);
    const section = settings.locator(`section[aria-label='${product.label}']`);
    await expect(section).toBeVisible();
    // The chip is the product's own state, so it can never again read
    // "Connected" for one forge while naming another's hosts.
    const chip = section.locator(".settings-card__chip").first();
    await expect(chip).toHaveText(/Connected|Signed out|Off|Not installed/);
    // Each product owns its own way in, which is what a shared empty state
    // could not offer. WHICH way in depends on the product's state, and both
    // branches are real here: CI runners carry `gh` but not `glab`, so one
    // section is "Not installed" on every run. A missing CLI is the one state
    // with no Add button — there is no binary to sign in with, so adding a
    // host would name an instance nothing can reach.
    // Trimmed: `textContent` is raw, unlike the whitespace-normalizing
    // `toHaveText` above, so any markup change that puts the label on its own
    // line would send this to the else branch and assert an Add button a
    // not-installed product deliberately does not render.
    if ((await chip.textContent())?.trim() === "Not installed") {
      await expect(section).toContainText(`Install the ${product.label} CLI`);
    } else {
      await expect(
        section.getByRole("button", { name: product.addHost.button })
      ).toBeVisible();
    }
  }
  // Folding one section leaves its neighbour alone — the reason collapse state
  // is per section and not per pane. Needs two products, so it is skipped on a
  // registry that has only one.
  const [first, second] = FORGE_KINDS.map((kind) => forgeProduct(kind).label);
  if (first !== undefined && second !== undefined) {
    const section = settings.locator(`section[aria-label='${first}']`);
    await section.getByRole("button", { name: first, exact: true }).click();
    await expect(
      section.getByRole("button", { name: first, exact: true })
    ).toHaveAttribute("aria-expanded", "false");
    // Scoped to the neighbour's own section, not the whole window: the nav now
    // carries a row per product too, and while its probe is still unanswered
    // that row's accessible name is the bare product label.
    await expect(
      settings
        .locator(`section[aria-label='${second}']`)
        .getByRole("button", { name: second, exact: true })
    ).toHaveAttribute("aria-expanded", "true");

    // The nav's Forges children — one per product, from the same registry the
    // sections come from, and each one a route back to its card. Clicking the
    // child unfolds the section the line above just folded and lands focus on
    // it, which is the whole contract: a child is a way to a card, not a pane.
    await expect(settings.locator(".settings-nav__subbutton")).toHaveCount(
      FORGE_KINDS.length
    );
    await settings
      .locator(".settings-nav__subbutton", { hasText: first })
      .click();
    await expect(
      section.getByRole("button", { name: first, exact: true })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      section.getByRole("button", { name: first, exact: true })
    ).toBeFocused();
  }

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
  expect(stored["general"]).toEqual({ theme: "light", developerMode: true });
  expect(stored["updates"]).toEqual({
    train: "beta",
    channel: "latest",
    selectionSource: "user"
  });
  expect(stored["experimental"]).toEqual({ lineageAllBranches: true });
  expect(stored["diagnostics"]).toEqual({ hotCpuProfilingEnabled: true });

  // Singleton: reopening from the menu focuses the same window.
  await openSettingsFromMenu(app);
  expect(app.windows().length).toBe(2);
});

test("Agents columns fit the settings pane at narrow widths and increased zoom", async ({}, testInfo) => {
  handle = await launchApp();
  const { app } = handle;
  const nextWindow = app.waitForEvent("window");
  await openSettingsFromMenu(app);
  const settings = await nextWindow;
  await settings.waitForSelector(".settings-screen");
  await settings.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(settings.locator(".agent-auth-column")).toHaveCount(3);
  for (const [width, zoom] of [[1040, 1], [1144, 1.3], [1440, 1], [1440, 1.3]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes("#settings"))!;
      win.setSize(size.width, 950);
      win.webContents.setZoomFactor(size.zoom);
    }, { width: width!, zoom: zoom! });
    await expect.poll(async () => Math.abs(await settings.evaluate(() => innerWidth) - width! / zoom!)).toBeLessThan(3);
    await expect.poll(() => settings.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".settings-content")!;
      const graph = document.querySelector<HTMLElement>(".agent-auth-graph")!;
      const columns = Array.from(graph.children).map(column => column.getBoundingClientRect());
      const available = document.querySelector(".settings-stack--agents")!.getBoundingClientRect().width;
      const stacked = columns[1]!.top > columns[0]!.top;
      return pane.scrollWidth <= pane.clientWidth + 1 && graph.scrollWidth <= graph.clientWidth + 1
        && stacked === (available <= 760);
    })).toBe(true);
    if (width === 1144) {
      await settings.locator(".agent-auth-graph").evaluate(element => element.scrollIntoView({ block: "start" }));
      const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes("#settings"))!;
        return (await win.capturePage()).toPNG().toString("base64");
      });
      writeFileSync(testInfo.outputPath("agents-stacked.png"), Buffer.from(screenshot, "base64"));
    }
  }
});
