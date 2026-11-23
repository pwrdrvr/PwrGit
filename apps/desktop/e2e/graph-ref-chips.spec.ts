import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
let html: string;
let app: ElectronApplication;
let page: Page;
const shots = process.env["PWRGIT_HARNESS_SHOTS"];
const benchmark = process.env.PWRGIT_GRAPH_REF_CHIPS_BENCH === "1";
const baselineHtml = process.env.PWRGIT_GRAPH_REF_CHIPS_BASELINE_HTML;

test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "pwrgit-ref-chips-"));
  html = await buildHarness("graph-ref-chips", join(out, "dist"), benchmark);
  app = await electron.launch({
    args: [
      `--user-data-dir=${join(out, "user")}`,
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

function readRows() {
  return page.evaluate(() => window.graphRefHarness.readRows());
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

test("restoring the last ref after a resize agrees with a fresh fit", async () => {
  const refs = ["feature/repair-widget-previews"];
  await page.evaluate((refs) => {
    window.graphRefHarness.mount(1, 120);
    window.graphRefHarness.changeRow({ refs, tag: undefined });
  }, refs);
  await settle();
  expect((await readRows())[0]).toMatchObject({ chips: [], folded: 1 });

  await page.evaluate(() => window.graphRefHarness.changeRow({ refs: [] }));
  await expect(page.locator(".ref-chips")).toHaveCount(0);
  await page.evaluate(() => window.graphRefHarness.resize(700));
  await settle();
  await page.evaluate((refs) => window.graphRefHarness.changeRow({ refs }), refs);
  const restored = await readRows();
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.locator(".graph-harness").screenshot({ path: join(shots, "restored-ref-700.png") });
  }

  await page.evaluate(() => window.graphRefHarness.remount());
  await settle();
  const fresh = await readRows();
  expect(fresh[0]).toMatchObject({ chips: [{ text: refs[0] }], folded: 0 });
  expect(restored).toEqual(fresh);
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

test("first fit bounds rigid slots and checks squeezed adornments before paint", async () => {
  await page.goto(pathToFileURL(html).href);
  const stackFontReady = await page.evaluate(async () => {
    await window.graphRefHarness.ready;
    return document.fonts.check('500 10px "Geist Mono"', "1/1");
  });
  expect(stackFontReady).toBe(true);
  for (const width of [800, 525.125, 490.5, 420, 382.625, 344.375, 311.125, 250.5, 175]) {
    const { rigidInteriorReads, rows } = await page.evaluate((width) => {
      window.graphRefHarness.prepareDeepScene(width);
      const original = Element.prototype.getBoundingClientRect;
      let reads = 0;
      Element.prototype.getBoundingClientRect = function () {
        if (this.matches(".ref-chips > :not(.is-squeezed) > *")) reads++;
        return original.call(this);
      };
      try {
        window.graphRefHarness.remount();
      } finally {
        Element.prototype.getBoundingClientRect = original;
      }
      // The exhaustive walk is the oracle. Read it in the same turn as mount.
      return { rigidInteriorReads: reads, rows: window.graphRefHarness.readRows() };
    }, width);
    expect(rows.every((row) => !row.clipped)).toBe(true);
    for (const [i, row] of rows.entries()) {
      const total = [10, 2, 2, 2, 0, 12, 11, 2, 2, 0][i % 10];
      expect(row.chips.length + row.folded).toBe(total);
      if (i % 10 === 6) expect(row.chips.length).toBeLessThanOrEqual(1);
    }
    expect(rigidInteriorReads).toBe(0);
  }
});

if (benchmark) {
  test("benchmarks first fit on a production-rendered deep graph", async () => {
    test.setTimeout(120_000);
    const versions = [{ name: "current", html }];
    if (baselineHtml !== undefined) versions.unshift({ name: "baseline", html: baselineHtml });
    for (const version of versions) {
      const assets = join(dirname(version.html), "assets");
      const client = readdirSync(assets).filter((name) => name.endsWith(".js"))
        .map((name) => readFileSync(join(assets, name), "utf8")).join("");
      expect(client).not.toContain("The current testing environment is not configured to support act");
    }
    await page.setViewportSize({ width: 900, height: 1620 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const metrics = async () => Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])
    );
    const cases = [24, 120].flatMap((count) => [800, 420].map((width) => ({ count, width })));
    const fits = new Map<string, string>();
    for (let sample = 0; sample < 13; sample++) {
      for (const { count, width } of sample % 2 === 0 ? cases : [...cases].reverse()) {
        for (const version of sample % 2 === 0 ? versions : [...versions].reverse()) {
          await page.goto(pathToFileURL(version.html).href);
          const production = await page.evaluate(async ({ width, count }) => {
            await window.graphRefHarness.ready;
            window.graphRefHarness.prepareDeepScene(width, count);
            return window.graphRefHarness.production;
          }, { width, count });
          expect(production).toBe(true);
          const before = await metrics();
          const wallMs = await page.evaluate(() => {
            const start = performance.now();
            window.graphRefHarness.remount();
            // Include final layout even when the last commit needed no fit read.
            document.querySelector(".graph-row:last-child")!.getBoundingClientRect();
            return performance.now() - start;
          });
          const after = await metrics();
          const rows = await readRows();
          expect(rows).toHaveLength(count);
          expect(rows.filter((row) => row.chips.length > 0 || row.folded > 0 || row.tag !== "none"))
            .toHaveLength(count - Math.floor(count / 10));
          expect(rows.every((row) => !row.clipped)).toBe(true);
          const visible = await page.locator(".graph-row").nth(23).evaluate((row) => (
            row.getBoundingClientRect().bottom <= row.closest(".graph-scroll")!.getBoundingClientRect().bottom
          ));
          expect(visible).toBe(true);
          const fit = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 12);
          const key = `${count}:${width}`;
          if (!fits.has(key)) fits.set(key, fit);
          expect(fit).toBe(fits.get(key));
          const geometryReads = await page.evaluate(() => {
            const original = Element.prototype.getBoundingClientRect;
            let reads = 0;
            Element.prototype.getBoundingClientRect = function () {
              if (this.closest(".commit-meta")) reads++;
              return original.call(this);
            };
            try {
              window.graphRefHarness.remount();
              return reads;
            } finally {
              Element.prototype.getBoundingClientRect = original;
            }
          });
          // The first pass warms up the browser. Each sample still mounts into a new document.
          if (sample === 0) continue;
          console.log(JSON.stringify({
            version: version.name, sample, count, width, fit, wallMs, geometryReads,
            layouts: after.LayoutCount! - before.LayoutCount!,
            layoutMs: (after.LayoutDuration! - before.LayoutDuration!) * 1000,
            taskMs: (after.TaskDuration! - before.TaskDuration!) * 1000
          }));
        }
      }
    }
  });
}

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
