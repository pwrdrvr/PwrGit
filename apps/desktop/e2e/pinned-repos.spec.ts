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
const mount = (page: Page, lens: string, grouped: boolean, theme = "dark"): Promise<void> =>
  page.evaluate(
    ([l, g, t]) =>
      (window as unknown as { __harness: Harness }).__harness.mount(
        l as string,
        g as boolean,
        t as string
      ),
    [lens, grouped, theme] as const
  );
const calls = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { __harness: Harness }).__harness.calls]);

/** Names top to bottom as laid out, with "—" where a seam is drawn. */
const column = (page: Page, selector: string): Promise<string[]> =>
  page.locator(selector).evaluateAll((els) =>
    els
      .map((el) => ({
        top: el.getBoundingClientRect().top,
        text: /seam/.test(el.className)
          ? "—"
          : (el.querySelector(".repo-row__name") ?? el).textContent ?? ""
      }))
      .sort((a, b) => a.top - b.top)
      .map((row) => row.text)
  );

const PINS = ["quartz-cli", "atlas", "tidepool"];
const REST = ["beacon-web", "cinder", "delta-svc", "ember", "lumen-api", "nimbus", "orchid", "zephyr"];

/**
 * Pinned repositories lead every lens, in both sidebar columns, in a Vite
 * build of the real `Sidebar` (`harness/pinned-repos`). jsdom cannot see
 * this: the rule is about what is laid out above what.
 * Design: `design/Pinned Repos Lead Every Lens - UX Review.dc.html`.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes each state as a PNG there.
 */
test("pinned repositories lead every lens, above one seam, in both columns", async () => {
  test.setTimeout(120_000);
  const out = mkdtempSync(join(tmpdir(), "pwrgit-pinned-repos-"));
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
    const shoot = async (name: string, park = true): Promise<void> => {
      if (!shots) return;
      // Parked off the list, except mid-drag, where a move is a `dragleave`.
      if (park) await page.mouse.move(0, 0);
      await page.screenshot({
        path: join(shots, `${name}.png`),
        clip: { x: 0, y: 0, width: 430, height: 520 }
      });
    };
    const tree = ".repo-row, .repo-seam";
    const index = ".repo-index__item, .repo-index__seam";

    for (const lens of ["All", "Focused", "Pinned"]) {
      await mount(page, lens, false);
      await expect(page.locator(".repo-index__item").first()).toBeVisible();
      await shoot(`${lens.toLowerCase()}-dark`);
      const rest = lens === "All" ? REST : lens === "Focused" ? ["lumen-api"] : [];
      expect(await column(page, tree), `${lens} tree`).toEqual([...PINS, "—", ...rest]);
      expect(await column(page, index), `${lens} index`).toEqual([...PINS, "—", ...rest]);
      // The label heads the rows below the seam, so a lens that lists only
      // pins draws the seam bare.
      await expect(page.locator(".repo-seam")).toHaveText(rest.length > 0 ? "Repositories" : "");
    }

    await mount(page, "All", false, "light");
    await expect(page.locator(".repo-index__item").first()).toBeVisible();
    await shoot("all-light");

    // The seam is a hairline in the index and a labelled divider in the tree.
    await mount(page, "All", false);
    await expect(page.locator(".repo-seam")).toHaveText("Repositories");
    const seam = (await page.locator(".repo-index__seam").boundingBox())!;
    expect(seam.height).toBe(9);

    // The star crosses the seam at once, to its place by name below it.
    await page.locator('.repo-row[data-repo-id="atlas"] .pin').click();
    expect(await calls(page)).toEqual(["pin:atlas:false"]);
    expect((await column(page, tree)).slice(0, 4)).toEqual(["quartz-cli", "tidepool", "—", "atlas"]);
    expect((await column(page, index)).slice(0, 4)).toEqual(["quartz-cli", "tidepool", "—", "atlas"]);

    // A keyboard toggle moves the row across the seam, and Chromium drops
    // focus from a moved node: it must come back to the star (SC 2.4.3).
    // Expanded first: the row must move, not remount, so its sections stay.
    const nimbus = page.locator('.repo-row[data-repo-id="nimbus"]');
    await nimbus.click();
    await expect(nimbus).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => {
      (window as unknown as { __nimbus: Element | null }).__nimbus = document.querySelector(
        '.repo-row[data-repo-id="nimbus"]'
      );
    });
    await nimbus.locator(".pin").focus();
    await page.keyboard.press("Enter");
    expect((await column(page, tree)).slice(0, 4)).toEqual(["quartz-cli", "tidepool", "nimbus", "—"]);
    await expect(nimbus.locator(".pin")).toBeFocused();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __nimbus: Element | null }).__nimbus ===
          document.querySelector('.repo-row[data-repo-id="nimbus"]')
      ),
      "the row is the same element after crossing the seam"
    ).toBe(true);
    await page.keyboard.press("Enter");
    await expect(nimbus.locator(".pin")).toBeFocused();
    await nimbus.click();

    // Nothing pinned: holding a repository opens the ghost Pin slot above
    // both columns, and a drop inside it pins. Playwright intercepts the
    // drag, so this proves the slot and its drop, not how the OS drag copes
    // with rows moving under it (Sidebar opens the slot a frame late for that).
    for (const id of ["quartz-cli", "tidepool"]) {
      await page.locator(`.repo-row[data-repo-id="${id}"] .pin`).click();
    }
    await expect(page.locator(".repo-seam")).toHaveCount(0);
    expect(await page.locator(".repo-pin-slot, .repo-index__pin-slot").count()).toBe(0);
    const held = (await page.locator('.repo-index__item[data-index-id="ember"]').boundingBox())!;
    await page.mouse.move(held.x + 20, held.y + held.height / 2);
    await page.mouse.down();
    await page.mouse.move(held.x + 24, held.y + held.height / 2 + 6, { steps: 4 });
    const treeSlot = page.locator(".repo-pin-slot");
    const indexSlot = page.locator(".repo-index__pin-slot");
    await expect(treeSlot).toBeVisible();
    await expect(indexSlot).toBeVisible();
    await expect(page.locator('.repo-index__item[data-index-id="ember"]')).toHaveClass(/is-dragging/);
    const slotBox = (await treeSlot.boundingBox())!;
    await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2, { steps: 8 });
    // Chromium sends `dragenter` on the move that arrives and `dragover` on
    // the next one, so settle inside the slot.
    await page.mouse.move(slotBox.x + slotBox.width / 2 + 3, slotBox.y + slotBox.height / 2 + 1, { steps: 2 });
    await expect(treeSlot).toHaveClass(/is-drop-target/);
    await expect(indexSlot).toHaveClass(/is-drop-target/);
    await shoot("pin-slot-dark", false);
    await page.mouse.up();
    await expect(treeSlot).toHaveCount(0);
    expect((await calls(page)).at(-1)).toBe("pin:ember:true");
    expect((await column(page, tree)).slice(0, 3)).toEqual(["ember", "—", "atlas"]);

    // Grouped by folder: a Pinned group above the folders, pins out of them.
    await page.mouse.move(0, 0);
    await mount(page, "All", true);
    await expect(page.locator(".repo-group__label").first()).toBeVisible();
    await expect(page.locator(".viewport-tooltip")).toHaveCount(0);
    await shoot("all-grouped-dark");
    expect(await page.locator(".repo-group__label").allTextContents()).toEqual(["Pinned", "code", "oss"]);
    expect((await column(page, tree)).slice(0, 5)).toEqual([...PINS, "—", "beacon-web"]);
    expect(await page.locator(".repo-index__label").allTextContents()).toEqual(["Pinned", "code", "oss"]);
  } finally {
    await app.close();
    rmSync(out, { recursive: true, force: true });
  }
});
