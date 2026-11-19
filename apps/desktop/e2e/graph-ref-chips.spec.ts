import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { harness } from "./harness/graph-ref-chips/main";

declare global {
  interface Window {
    graphRefHarness: typeof harness;
  }
}

let out: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "pwrgit-ref-chips-"));
  const html = await buildHarness("graph-ref-chips", join(out, "dist"));
  app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      join(dirname(fileURLToPath(import.meta.url)), "harness", "electron-main.cjs")
    ],
    env: cleanEnv({
      PWRGIT_HARNESS_HTML: html,
      PWRGIT_HARNESS_WIDTH: "900",
      PWRGIT_HARNESS_HEIGHT: "720"
    })
  });
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => "graphRefHarness" in window);
  await page.evaluate(() => window.graphRefHarness.ready);
});

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

async function settle() {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ));
}

async function readRows() {
  return page.locator(".graph-row").evaluateAll((rows) => rows.map((row) => {
    const strip = row.querySelector(".ref-chips");
    const edge = strip?.getBoundingClientRect().right ?? Infinity;
    const tag = row.querySelector(".commit-tag--tag");
    return {
      chips: [...row.querySelectorAll(".ref-chip__name")].map((name) => ({
        text: name.textContent,
        truncated: name.scrollWidth > name.clientWidth,
        squeezed: name.parentElement!.classList.contains("is-squeezed")
      })),
      folded: Number(strip?.querySelector(".ref-chip--more")?.textContent?.slice(1) ?? "0"),
      clipped: [...row.querySelectorAll(".ref-chips > *, .ref-chips > * > *")].some(
        (part) => part.getBoundingClientRect().right > edge + 0.5
      ),
      tag: tag?.classList.contains("is-glyph") ? "glyph"
        : tag?.classList.contains("is-squeezed") ? "squeezed"
        : tag === null ? "none" : "whole"
    };
  }));
}

test("only measures strips whose content changed in a graph refresh", async () => {
  await page.evaluate(() => window.graphRefHarness.mount(80, 490));
  await settle();
  const measured = await page.evaluate(() => {
    const original = window.getComputedStyle;
    const strips: (string | null)[] = [];
    window.getComputedStyle = (element, pseudo) => {
      if (element.classList.contains("ref-chips")) {
        strips.push(element.closest(".graph-row")!.getAttribute("data-hash"));
      }
      return original(element, pseudo);
    };
    try {
      window.graphRefHarness.refresh();
      const equivalent = strips.splice(0);
      window.graphRefHarness.changeBranch(true, true);
      return { equivalent, updated: strips };
    } finally {
      window.getComputedStyle = original;
    }
  });
  expect(measured).toEqual({ equivalent: [], updated: ["0000000"] });
});

test("width and content changes agree with a fresh fit across the chip ladder", async () => {
  await page.evaluate(() => window.graphRefHarness.mount(10, 700));
  await settle();
  const wide = await readRows();
  expect(wide[0]!.chips.map(({ text }) => text)).toEqual(["feature/WWWW-widget-preview-0", "widget-0"]);
  expect(wide[0]!.folded).toBe(8);
  expect(wide[3]!.chips.map(({ text }) => text)).toEqual(["origin/widget-3", "upstream"]);

  let sawSqueezedBranch = false;
  for (const width of [490, 360, 260, 150, 700]) {
    await page.evaluate((w) => window.graphRefHarness.resize(w), width);
    await settle();
    const resized = await readRows();
    for (const [i, total] of [10, 2, 2, 2, 0].entries()) {
      const row = resized[i]!;
      expect(row.chips.length + row.folded).toBe(total);
      expect(row.clipped).toBe(false);
    }
    await page.evaluate(() => window.graphRefHarness.remount());
    await settle();
    expect(resized).toEqual(await readRows());
    sawSqueezedBranch ||= resized.some((row) => row.chips.some((chip) => chip.squeezed && chip.truncated));
    if (width === 260) expect(resized[0]).toMatchObject({ folded: 10, tag: "squeezed" });
    if (width === 150) expect(resized[0]!.tag).toBe("glyph");
  }
  expect(sawSqueezedBranch).toBe(true);

  await page.evaluate(() => {
    window.graphRefHarness.resize(490);
    window.graphRefHarness.changeBranch(true, true);
  });
  await settle();
  const adorned = await readRows();
  await page.evaluate(() => window.graphRefHarness.remount());
  await settle();
  expect(adorned).toEqual(await readRows());

  await page.evaluate(() => window.graphRefHarness.changeRow({
    refs: ["main"],
    remoteRefs: ["origin"],
    tag: { name: "v2.1", kind: "lightweight" },
    isHead: true
  }));
  await settle();
  const changed = await readRows();
  expect(changed[0]!.chips.map(({ text }) => text)).toEqual(["main", "origin"]);
  expect(changed[0]!.folded).toBe(0);
  await page.evaluate(() => window.graphRefHarness.remount());
  await settle();
  expect(changed).toEqual(await readRows());
});

test("a late font refits the row at an unchanged width", async () => {
  await page.evaluate(() => window.graphRefHarness.mount(10, 390, true));
  await settle();
  const fallback = await readRows();
  await page.evaluate(() => window.graphRefHarness.loadWideFont());
  await settle();
  const loaded = await readRows();
  expect(loaded[0]!.folded).toBeGreaterThan(fallback[0]!.folded);
  await page.evaluate(() => window.graphRefHarness.remount());
  await settle();
  expect(loaded).toEqual(await readRows());
});

const shots = process.env["PWRGIT_HARNESS_SHOTS"];
if (shots) {
  test("captures wide, squeezed and folded chip layouts", async () => {
    mkdirSync(shots, { recursive: true });
    for (const width of [700, 360, 260]) {
      await page.evaluate((w) => window.graphRefHarness.mount(5, w), width);
      await settle();
      await page.locator(".graph-harness").screenshot({ path: join(shots, `ref-chips-${width}.png`) });
    }
  });
}
