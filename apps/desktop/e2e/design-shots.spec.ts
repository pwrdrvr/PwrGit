import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { forgeProduct } from "@pwrgit/shared";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

/**
 * Captures Settings → Forges for the design bundle.
 *
 * Opt-in only — it writes artifacts into a repo that publishes them, and a
 * caption changing is not a regression:
 *
 *   PWRGIT_DESIGN_SHOTS=1 npx playwright test -c playwright.config.ts design-shots.spec.ts
 *
 * The host estate is **100% contrived**. `fixtures/forge-cli-stubs/` goes on
 * `PATH` ahead of any real `gh`/`glab`, so no real account, instance or token
 * can reach an image that ships in a public repo — the rule `design/SOURCE.md`
 * states for anything under `design/assets/`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STUBS = join(HERE, "fixtures", "forge-cli-stubs");
const OUT =
  process.env["PWRGIT_DESIGN_SHOTS_DIR"] ??
  join(HERE, "..", "..", "..", "design", "assets");
const WINDOW = { width: 1180, height: 860 };

let handle: AppHandle | null = null;
let realPath: string | undefined;

test.skip(
  process.env["PWRGIT_DESIGN_SHOTS"] !== "1",
  "design captures are opt-in"
);

test.beforeEach(() => {
  // `launchApp` builds the child env from `process.env`, so prepending here is
  // what puts the stubs in front of a real CLI for the app under test.
  realPath = process.env["PATH"];
  process.env["PATH"] = `${STUBS}${delimiter}${realPath ?? ""}`;
});

test.afterEach(async () => {
  if (realPath !== undefined) process.env["PATH"] = realPath;
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
});

async function openSettings(app: AppHandle["app"]): Promise<Page> {
  const opened = app.waitForEvent("window");
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
  const settings = await opened;
  await settings.waitForSelector(".settings-screen");
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("#settings")
    );
    if (win === undefined) throw new Error("no settings window to size");
    win.setBounds({ x: 0, y: 0, ...size });
  }, WINDOW);
  return settings;
}

test("Settings → Forges, on a contrived estate", async () => {
  mkdirSync(OUT, { recursive: true });
  handle = await launchApp({ theme: "dark" });
  const settings = await openSettings(handle.app);

  await settings.locator(".settings-nav__button", { hasText: "Forges" }).click();
  await settings.waitForSelector("section[aria-label='GitHub']");

  // A host somebody added by hand — the row that carries a sign-in command and
  // a Remove button. Added through the real dialog, so it is a real write.
  await settings
    .getByRole("button", { name: forgeProduct("gitlab").addHost.button })
    .click();
  await settings.locator(".modal__input").fill("gitlab.contoso-labs.test");
  await settings.getByRole("button", { name: "Add host" }).click();
  await settings.waitForSelector("[role='dialog']", { state: "detached" });

  // One host deliberately switched off, so the neutral "Off" state is on screen
  // beside the ones that are on.
  await settings
    .getByLabel("Read GitHub status from ghe.contoso-labs.test")
    .click();
  await settings.waitForTimeout(1200);

  // Back to the top before the shutter: toggling a row scrolls the pane, and
  // the first section's header — the thing this change is about — is what
  // scrolls off.
  await settings.locator(".settings-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await settings.waitForTimeout(200);

  await settings.screenshot({ path: join(OUT, "forges-after.png") });

  // Folded: what the disclosure is for, and the state that proves each header
  // still says which product it is, how it is doing, and from where.
  await settings.getByRole("button", { name: "Collapse all" }).click();
  await settings.waitForTimeout(300);
  await settings.screenshot({ path: join(OUT, "forges-collapsed.png") });
});
