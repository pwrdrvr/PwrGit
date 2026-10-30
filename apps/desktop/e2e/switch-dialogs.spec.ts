import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

/**
 * The branch-switch prompts and the "your changes are waiting" toast, as the
 * real `DialogHost` and `ToastHost` draw them.
 *
 * Not the app: a Vite build of the real components and the real
 * `guardedSwitchBranch` against a fake preload bridge
 * (`harness/switch-dialogs`), in a hidden Electron window, with contrived
 * data. `dirty-switch.spec.ts` drives the same flows against real Git in the
 * built app; this one pins what the reader is shown, and is safe to run on a
 * developer's machine.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each surface as a PNG there.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "harness", "electron-main.cjs");

type Harness = {
  ready: Promise<void>;
  start: (scene: "dirty" | "return") => void;
  calls: () => { name: string; req: unknown }[];
};

let out: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  out = mkdtempSync(join(tmpdir(), "pwrgit-switch-dialogs-"));
  const html = await buildHarness("switch-dialogs", join(out, "dist"));
  app = await electron.launch({
    args: [
      // As `launchApp` does: hardware codecs leak VideoToolbox clients in the
      // Tart guests even with the GPU off (e2e/AGENTS.md).
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      MAIN
    ],
    env: cleanEnv({
      PWRGIT_HARNESS_HTML: html,
      PWRGIT_HARNESS_WIDTH: "960",
      PWRGIT_HARNESS_HEIGHT: "720"
    })
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => "__harness" in window);
  await page.evaluate(
    () => (window as unknown as { __harness: Harness }).__harness.ready
  );
});

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

/** Write `target` (with a margin) when shots were asked for. */
async function shoot(target: Locator, name: string): Promise<void> {
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots === undefined || shots === "") return;
  mkdirSync(shots, { recursive: true });
  // Let the entrance animations finish, or the shot catches a half-faded
  // panel. Only short, finite ones: a toast's countdown runs for seconds.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return (
            timing !== undefined &&
            Number.isFinite(timing.endTime as number) &&
            (timing.endTime as number) <= 2_000
          );
        })
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${name}: nothing to shoot`);
  const margin = 20;
  const viewport = page.viewportSize() ?? { width: 960, height: 720 };
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  await page.screenshot({
    path: join(shots, name),
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + margin * 2),
      height: Math.min(viewport.height - y, box.height + margin * 2)
    }
  });
}

const start = (scene: "dirty" | "return"): Promise<void> =>
  page.evaluate(
    (next) => (window as unknown as { __harness: Harness }).__harness.start(next),
    scene
  );

const calls = (): Promise<{ name: string; req: unknown }[]> =>
  page.evaluate(() =>
    (window as unknown as { __harness: Harness }).__harness.calls()
  );

test("both prompts name where the work goes, and nothing moves on cancel", async () => {
  await start("dirty");
  const prompt = page.locator(".modal--choice");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("Switch to feature/rate-cards?");
  await expect(prompt).toContainText(
    "lumen-api has 3 uncommitted changes. Where should they go?"
  );
  // Bring is first, so it is the default and holds focus.
  await expect(
    prompt.getByRole("button", { name: /^Bring my changes to feature\/rate-cards/ })
  ).toBeFocused();
  await expect(
    prompt.getByRole("button", { name: /^Leave my changes on main/ })
  ).toBeVisible();
  await expect(prompt.getByRole("button", { name: /commit/i })).toHaveCount(0);
  await shoot(prompt, "switch-after.png");

  await prompt
    .getByRole("button", { name: /^Bring my changes to feature\/rate-cards/ })
    .click();
  const overwrite = page.locator(".modal--choice", {
    hasText: "feature/rate-cards has its own version of this file"
  });
  await expect(overwrite).toBeVisible();
  await expect(overwrite.locator(".dialog__facts")).toContainText(
    "src/pricing/quote.ts"
  );
  await expect(
    overwrite.getByRole("button", {
      name: /^Merge my changes into feature\/rate-cards's/
    })
  ).toBeVisible();
  await expect(
    overwrite.getByRole("button", { name: /^Leave my changes on main/ })
  ).toBeVisible();
  await shoot(overwrite, "switch-overwrite-after.png");

  await overwrite.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".modal--choice")).toHaveCount(0);
  // One refused plain switch, and nothing after the cancel.
  const switches = (await calls()).filter((c) => c.name === "branch:switch");
  expect(switches.map((c) => c.req)).toEqual([
    { worktreeId: "wt-lumen", branch: "feature/rate-cards" }
  ]);
});

test("coming back offers the changes left there, and Restore puts them back", async () => {
  await start("return");
  const offer = page.locator(".app-toast", {
    hasText: "You left 3 changes on main."
  });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Your changes are waiting");
  await expect(offer).toContainText("lumen-api");
  await shoot(offer, "switch-restore-toast.png");

  await offer.getByRole("button", { name: "Restore" }).click();
  await expect
    .poll(async () =>
      (await calls()).filter((c) => c.name === "stash:pop").map((c) => c.req)
    )
    .toEqual([
      {
        worktreeId: "wt-lumen",
        stashHash: "4f1c2d9e7a3b5c6d8e9f0a1b2c3d4e5f6a7b8c9d"
      }
    ]);
  await expect(
    page.locator(".app-toast", { hasText: "Your changes are back on main." })
  ).toBeVisible();
});
