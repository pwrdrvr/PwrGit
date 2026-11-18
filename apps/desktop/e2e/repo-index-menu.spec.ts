import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

type Harness = {
  ready: Promise<void>;
  calls: string[];
  mount: (lens: string, grouped: boolean, theme: string) => void;
};
const mount = (page: Page, lens: string, theme: string): Promise<void> =>
  page.evaluate(
    ([l, t]) =>
      (window as unknown as { __harness: Harness }).__harness.mount(l as string, false, t as string),
    [lens, theme] as const
  );

const menuEntries = (page: Page): Promise<string[]> =>
  page
    .getByRole("menu")
    .locator('[role^="menuitem"]')
    .evaluateAll((els) =>
      els.map((el) => `${el.textContent ?? ""}${(el as HTMLButtonElement).disabled ? " [disabled]" : ""}`)
    );

/**
 * A right-click on a repository's name in the index opens that repository's
 * own menu, the one its tree row opens, as PwrAgnt's project index opens the
 * project header's. Runs on the `pinned-repos` harness (a Vite build of the
 * real `Sidebar`; pins quartz-cli, atlas, tidepool).
 * Design: `design/Repo Index Context Menu - UX Review.dc.html`, 2a and 2b.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("an index name opens its repository's own menu", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-repo-index-menu-"));
  const html = await buildHarness("pinned-repos", join(out, "dist"));
  const app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      join(dirname(fileURLToPath(import.meta.url)), "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "460", PWRGIT_HARNESS_HEIGHT: "560" })
  });
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => "__harness" in window);
    await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
    const shoot = async (name: string): Promise<void> => {
      if (!shots) return;
      // The menu fades in (pg-fade); shoot it settled, not half-drawn.
      await page
        .getByRole("menu")
        .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await page.screenshot({
        path: join(shots, `${name}.png`),
        clip: { x: 0, y: 0, width: 430, height: 520 }
      });
    };
    const name = (text: string) =>
      page.locator(".repo-index__item", { hasText: new RegExp(`^${text}$`) });

    for (const theme of ["dark", "light"]) {
      await mount(page, "All", theme);
      await expect(name("atlas")).toBeVisible();

      // Unpinned: Pin leads, no moves.
      await name("ember").click({ button: "right" });
      await shoot(`unpinned-${theme}`);
      await expect(page.getByRole("menu", { name: "ember actions" })).toBeVisible();
      expect((await menuEntries(page)).slice(0, 3)).toEqual([
        "Pin repository",
        "Reveal in Finder",
        "Copy path"
      ]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);

      // A pin in the middle of three: both moves, with their keys.
      await name("atlas").click({ button: "right" });
      await shoot(`pinned-${theme}`);
      const fromIndex = await menuEntries(page);
      expect(fromIndex.slice(0, 3)).toEqual(["Unpin repository", "Move up⇧⌘↑", "Move down⇧⌘↓"]);
      await page.keyboard.press("Escape");

      // The same menu as the tree row's, entry for entry.
      await page.locator('.repo-row[data-repo-id="atlas"]').click({ button: "right" });
      expect(await menuEntries(page)).toEqual(fromIndex);
      await page.keyboard.press("Escape");
    }
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
