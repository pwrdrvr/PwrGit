import { readFileSync } from "node:fs";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PWRGIT_LINKS } from "@pwrgit/shared";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

const DESKTOP_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string }
).version;

let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
});

async function clickMenuItem(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, itemLabel) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find((candidate) => candidate.label === itemLabel);
      if (item !== undefined) {
        item.click();
        return;
      }
    }
    throw new Error(`Menu item not found: ${itemLabel}`);
  }, label);
}

async function helpLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()?.items.find((item) => item.role === "help");
    return (help?.submenu?.items ?? [])
      .filter((item) => item.type !== "separator")
      .map((item) => item.label);
  });
}

async function stubExternalOpening(
  app: ElectronApplication,
  fail: boolean
): Promise<void> {
  await app.evaluate(({ shell }, shouldFail) => {
    const scope = globalThis as unknown as { __pwrgitOpenedLinks: string[] };
    scope.__pwrgitOpenedLinks = [];
    shell.openExternal = async (url: string) => {
      scope.__pwrgitOpenedLinks.push(url);
      if (shouldFail) throw new Error("simulated offline browser");
    };
  }, fail);
}

async function openedLinks(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __pwrgitOpenedLinks?: string[] })
        .__pwrgitOpenedLinks ?? []
  );
}

async function openSettings(app: ElectronApplication): Promise<Page> {
  const settingsWindowPromise = app.waitForEvent("window");
  await clickMenuItem(app, "Settings…");
  const settings = await settingsWindowPromise;
  await settings.waitForSelector(".settings-screen");
  return settings;
}

test("Help and About expose identity, canonical support links, and recovery", async () => {
  handle = await launchApp();
  const { app } = handle;
  await stubExternalOpening(app, false);

  expect(await helpLabels(app)).toEqual(
    expect.arrayContaining([
      "PwrGit Documentation",
      "PwrGit Website",
      "Release Notes",
      "View Source",
      "Report an Issue…",
      "Security Reporting (Private)…",
      "Check for Updates",
      "View License",
      "Third-Party Notices",
      "Logs"
    ])
  );

  await clickMenuItem(app, "PwrGit Documentation");
  await expect.poll(() => openedLinks(app)).toContain(PWRGIT_LINKS.documentation);

  const settings = await openSettings(app);
  await settings.getByRole("button", { name: "About", exact: true }).click();
  const about = settings.locator("[aria-label='About PwrGit']");
  await expect(about).toBeVisible();

  const runtime = await app.evaluate(({ app: electronApp }) => {
    const electronProcess = process as NodeJS.Process & {
      getSystemVersion: () => string;
    };
    return {
      runtimeVersion: electronApp.getVersion(),
      electronVersion: electronProcess.versions.electron ?? "unknown",
      platformVersion: electronProcess.getSystemVersion(),
      arch: electronProcess.arch
    };
  });
  expect(runtime.runtimeVersion).toBe(runtime.electronVersion);
  expect(DESKTOP_VERSION).not.toBe(runtime.electronVersion);
  await expect(about).toContainText(`v${DESKTOP_VERSION}`);
  await expect(about).toContainText("Stable · Latest");
  await expect(about).toContainText("Development build");
  await expect(about).toContainText(`${runtime.platformVersion} (${runtime.arch})`);
  await expect(about).toContainText(`Electron ${runtime.electronVersion}`);
  await expect(about).toContainText(PWRGIT_LINKS.source);
  await expect(about).toContainText("Do not post vulnerabilities publicly");

  await settings.getByRole("button", { name: "Open releases" }).click();
  await expect.poll(() => openedLinks(app)).toContain(PWRGIT_LINKS.releases);

  await settings.evaluate(() => {
    const scope = window as unknown as { __pwrgitCopiedIdentity?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          scope.__pwrgitCopiedIdentity = text;
        }
      }
    });
  });
  await settings
    .getByRole("button", { name: "Copy diagnostics identity" })
    .click();
  await expect(settings.getByRole("status")).toHaveText(
    "Diagnostics identity copied."
  );
  const copiedIdentity = await settings.evaluate(
    () =>
      (window as unknown as { __pwrgitCopiedIdentity?: string })
        .__pwrgitCopiedIdentity
  );
  expect(copiedIdentity).toContain(`PwrGit ${DESKTOP_VERSION}`);
  expect(copiedIdentity).toContain(`Electron: ${runtime.electronVersion}`);
  expect(copiedIdentity).toContain("Build: Development");
  expect(copiedIdentity).toContain(`${runtime.platformVersion} (${runtime.arch})`);

  await stubExternalOpening(app, true);
  await settings.getByRole("button", { name: "Open documentation" }).click();
  const alert = settings.getByRole("alert");
  await expect(alert).toContainText("Copy the address");
  await expect(alert).toContainText("when you’re online");
  await expect(about).toContainText(PWRGIT_LINKS.documentation);
});
