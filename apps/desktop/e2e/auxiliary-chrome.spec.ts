import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

let handle: AppHandle | null = null;

test.afterEach(async () => {
  await handle?.cleanup();
  handle = null;
});

async function openMenuItem(
  app: AppHandle["app"],
  label: string
): Promise<Page> {
  const windowPromise = app.waitForEvent("window");
  await app.evaluate(({ Menu }, requestedLabel) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find(
        (candidate) => candidate.label === requestedLabel
      );
      if (item !== undefined) {
        item.click();
        return;
      }
    }
    throw new Error(`Menu item not found: ${requestedLabel}`);
  }, label);
  return windowPromise;
}

async function expectAuxiliaryChrome(
  app: AppHandle["app"],
  window: Page,
  expectedTitle: string
): Promise<void> {
  const titlebar = window.locator(".auxiliary-titlebar");
  await expect(titlebar).toBeVisible();
  await expect(titlebar.locator(".auxiliary-titlebar__title")).toHaveText(
    expectedTitle
  );

  const platform = await window.evaluate(
    () => document.documentElement.dataset["platform"]
  );
  const layout = await titlebar.evaluate((element) => {
    const style = getComputedStyle(element);
    const gutter = element.querySelector<HTMLElement>(".titlebar__gutter");
    return {
      backgroundColor: style.backgroundColor,
      gutterDisplay: gutter === null ? "missing" : getComputedStyle(gutter).display,
      paddingRight: style.paddingRight
    };
  });

  if (platform === "win32") {
    expect(layout).toEqual({
      backgroundColor: "rgb(5, 5, 5)",
      gutterDisplay: "none",
      paddingRight: "150px"
    });
    const menuVisible = await app.evaluate(({ BrowserWindow }, url) => {
      const target = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === url
      );
      return target?.isMenuBarVisible() ?? null;
    }, window.url());
    expect(menuVisible).toBe(false);
  } else if (platform === "darwin") {
    expect(layout.gutterDisplay).not.toBe("none");
  }
}

test("secondary windows share themed platform chrome", async () => {
  handle = await launchApp();
  const { app } = handle;

  const nativeAppearance = await app.evaluate(({ nativeTheme }) => ({
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource
  }));
  expect(nativeAppearance).toEqual({
    shouldUseDarkColors: true,
    themeSource: "dark"
  });

  const cases = [
    { menu: "Settings…", title: "General" },
    { menu: "Logs", title: "Logs" },
    { menu: "View License", title: "PwrGit License" },
    { menu: "Third-Party Notices", title: "PwrGit Third-Party Notices" }
  ];

  for (const item of cases) {
    const auxiliary = await openMenuItem(app, item.menu);
    await expectAuxiliaryChrome(app, auxiliary, item.title);
    await auxiliary.close();
  }
});
