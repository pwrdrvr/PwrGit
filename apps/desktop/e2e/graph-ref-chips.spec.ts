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

test("CSS keeps the ref controls whole on mount, resize, refresh and a late font load", async () => {
  const widths = [800, 693.5, 637, 599.875, 525.125, 490.5, 420, 382.625, 344.375, 311.125, 276, 250.5, 175, 150];
  const readAudit = await page.evaluate(async (widths) => {
    const geometry: Record<string, number> = {};
    const original = {
      rect: Element.prototype.getBoundingClientRect,
      rects: Element.prototype.getClientRects,
      style: window.getComputedStyle,
      resize: window.ResizeObserver,
      intersection: window.IntersectionObserver
    };
    const restore: (() => void)[] = [];
    // The oracle itself runs between audit windows. Count application reads
    // during synchronous commits and through the following browser frames.
    let audit = true;
    const mark = (what: string) => { if (audit) geometry[what] = (geometry[what] ?? 0) + 1; };
    Element.prototype.getBoundingClientRect = function () {
      mark("bounding rect");
      return original.rect.call(this);
    };
    Element.prototype.getClientRects = function () {
      mark("client rects");
      return original.rects.call(this);
    };
    window.getComputedStyle = (element, pseudo) => {
      mark("computed style");
      return original.style.call(window, element, pseudo);
    };
    window.ResizeObserver = class extends original.resize {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        mark("resize observer");
      }
    };
    window.IntersectionObserver = class extends original.intersection {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        mark("intersection observer");
      }
    };
    for (const [proto, properties] of [
      [Element.prototype, ["clientWidth", "clientHeight", "scrollWidth", "scrollHeight"]],
      [HTMLElement.prototype, ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"]]
    ] as const) {
      for (const name of properties) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
        Object.defineProperty(proto, name, {
          ...descriptor,
          get() { mark(name); return descriptor.get!.call(this); }
        });
        restore.push(() => Object.defineProperty(proto, name, descriptor));
      }
    }
    const harness = window.graphRefHarness;
    const snapshot = () => {
      audit = false;
      try { return harness.readRows(); } finally { audit = true; }
    };
    const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    try {
      harness.prepareDeepScene(widths[0]!);
      harness.remount();
      const cases = [];
      for (const width of widths) {
        harness.resize(width);
        const resized = snapshot();
        harness.remount();
        const mounted = snapshot();
        cases.push({ width, resized, mounted });
        await frames();
      }
      harness.mount(5, 390, true);
      harness.changeBranch(true, true);
      harness.changeRow({
        refs: ["feature/" + "W".repeat(200), "ready", "archived"],
        remoteRefs: ["origin/" + "M".repeat(100)],
        tag: { name: "release/" + "W".repeat(100), kind: "lightweight" },
        isHead: true
      });
      const changed = snapshot();
      await harness.loadWideFont();
      await frames();
      const loaded = snapshot();
      harness.refresh();
      const refreshed = snapshot();
      harness.remount();
      const fresh = snapshot();
      return { geometry, cases, changed, loaded, refreshed, fresh };
    } finally {
      Element.prototype.getBoundingClientRect = original.rect;
      Element.prototype.getClientRects = original.rects;
      window.getComputedStyle = original.style;
      window.ResizeObserver = original.resize;
      window.IntersectionObserver = original.intersection;
      for (const reset of restore) reset();
    }
  }, widths);
  expect(readAudit.geometry).toEqual({});
  const summaries = ["11 refs", "2 refs", "2 refs", "2 refs", "1 ref", "12 refs", "11 refs", "2 refs", "2 refs", null];
  for (const { mounted, resized, width } of readAudit.cases) {
    expect(mounted, `first frame at ${width}px`).toEqual(resized);
    for (const [i, row] of mounted.entries()) {
      expect(row.clipped, `row ${i} at ${width}px`).toEqual([]);
      expect(row.summary).toBe(summaries[i % summaries.length]);
    }
  }
  expect(readAudit.cases[0]!.mounted[0]!.chips.map(({ text }) => text))
    .toEqual(["preview/WWWW-widgets-0", "feature/WWWW-widget-preview-0", "widget-0"]);
  expect(readAudit.cases.find(({ width }) => width === 420)!.mounted[0]!.chips.map(({ text }) => text))
    .toEqual(["preview/WWWW-widgets-0", "feature/WWWW-widget-preview-0"]);
  expect(readAudit.changed[0]!.summary).toBe("5 refs");
  expect(readAudit.changed[0]!.chips.some(({ truncated }) => truncated)).toBe(true);
  expect(readAudit.changed[0]!.clipped).toEqual([]);
  expect(readAudit.loaded[0]!.clipped).toEqual([]);
  expect(readAudit.loaded).toEqual(readAudit.fresh);
  expect(readAudit.refreshed).toEqual(readAudit.fresh);
});

const publishedTag = {
  name: "v7",
  local: { kind: "lightweight" as const, targetId: "old", objectId: "a" },
  published: { kind: "lightweight" as const, targetId: "new", objectId: "b", remote: "origin" }
};

async function crowdedHead() {
  await page.evaluate(() => {
    const harness = window.graphRefHarness;
    harness.mount(1, 360);
    harness.changeBranch(true, true);
    harness.changeRow({
      refs: ["feature/WWWW-widget-preview-0"],
      tag: { name: "release/" + "W".repeat(60), kind: "lightweight" },
      isHead: true
    });
  });
}

test("a crowded HEAD reserves room for every visible ref control before Browse", async () => {
  await crowdedHead();
  for (const width of [360, 340, 382, 405, 420, 490, 650, 800, 276]) {
    await page.evaluate((width) => window.graphRefHarness.resize(width), width);
    expect((await readRows())[0]!.clipped, `crowded HEAD at ${width}px`).toEqual([]);
    const obscured = await page.locator(".commit-meta").evaluate((line) =>
      [...line.querySelectorAll(".ref-chips button, .ref-chips [role=button], .ref-browser")].flatMap((control) => {
        if (control.getClientRects().length === 0) return [];
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return control.contains(hit) ? [] : [control.className];
      })
    );
    expect(obscured, `hit targets at ${width}px`).toEqual([]);
  }
});

test("a published tag keeps a direct warning beside a local tag", async () => {
  await crowdedHead();
  await page.evaluate((tag) => window.graphRefHarness.changeRow({ publishedTags: [tag] }), publishedTag);
  const local = page.locator(".commit-meta > span.commit-tag--tag");
  const warning = page.locator(".commit-meta > button.commit-tag--tag.is-published");
  await page.evaluate(() => window.graphRefHarness.resize(800));
  await expect(local).toBeVisible();
  for (const width of [800, 650, 490, 420, 405, 382, 360, 340, 276]) {
    await page.evaluate((width) => window.graphRefHarness.resize(width), width);
    await expect(warning.locator(".tag-glyph"), `published warning at ${width}px`).toBeVisible({ timeout: 1500 });
    expect((await readRows())[0]!.clipped, `published warning at ${width}px`).toEqual([]);
  }
  await warning.press("Enter");
  expect(await page.evaluate(() => window.graphRefHarness.lastAction())).toBe("tag:v7");
  await page.evaluate(() => window.graphRefHarness.changeRow({
    pullRequest: { number: 23, title: "Promote preview", url: "https://forge.example.test/pull/23", state: "open", isDraft: false }
  }));
  const clipped = [];
  for (const width of [276, 320, 340, 360, 382, 405, 420, 463, 490, 650, 800]) {
    await page.evaluate((width) => window.graphRefHarness.resize(width), width);
    const row = (await readRows())[0]!;
    if (row.clipped.length > 0) clipped.push({ width, controls: row.clipped });
  }
  expect(clipped).toEqual([]);
});

test("the ref list keeps every ordered name and reaches hidden branch actions by keyboard", async () => {
  await page.evaluate(() => window.graphRefHarness.mount(1, 276));
  const summary = page.getByRole("button", { name: "Browse 11 refs at 0000000" });
  const list = page.getByRole("region", { name: "Refs at 0000000" });
  await expect(list).toBeHidden();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(list).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(11);
  await expect(list.locator(".commit-tag__name, .ref-chip__name")).toHaveText([
    "preview/WWWW-widgets-0", "feature/WWWW-widget-preview-0", "widget-0",
    ...Array.from({ length: 8 }, (_, i) => `archive/0-${i}`)
  ]);
  await page.keyboard.press("Tab");
  await expect(list.getByRole("button", { name: "Actions for branch feature/WWWW-widget-preview-0" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(summary).toBeFocused();

  const remote = "upstream/" + "a-long-ref-segment-".repeat(20);
  await page.evaluate((remote) => window.graphRefHarness.changeRow({ remoteRefs: [remote, "origin"] }), remote);
  await page.getByRole("button", { name: "Browse 13 refs at 0000000" }).press("Space");
  const action = list.getByRole("button", { name: `Actions for remote branch ${remote}` });
  await expect(action).toBeVisible();
  await expect(list.locator(".ref-chip--remote .ref-chip__name")).toHaveText([remote, "origin"]);
  expect(await action.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
  await action.press("Enter");
  await expect(list).toBeHidden();
  const branchMenu = page.getByRole("menu", { name: `${remote} actions` });
  await expect(branchMenu.getByRole("menuitem", { name: /^Reset main to upstream/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(branchMenu).toBeHidden();
  await expect(page.getByRole("button", { name: "Browse 13 refs at 0000000" })).toBeFocused();
});

test("reopening Browse dismisses branch actions and leaves Escape with the ref list", async () => {
  await page.evaluate(() => window.graphRefHarness.mount(1, 276));
  const summary = page.getByRole("button", { name: "Browse 11 refs at 0000000" });
  const list = page.getByRole("region", { name: "Refs at 0000000" });
  const menu = page.getByRole("menu", { name: "widget-0 actions" });
  for (const reopen of [() => summary.click(), () => summary.press("Enter")]) {
    await summary.press("Enter");
    await list.getByRole("button", { name: "Actions for branch widget-0" }).press("Enter");
    await expect(menu).toBeVisible();
    await reopen();
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden({ timeout: 1500 });
    await expect(menu).toBeHidden();
    await expect(summary).toBeFocused();
  }
});

test("scrolling the row offscreen dismisses the ref list and its focused action", async () => {
  await page.evaluate((tag) => {
    window.graphRefHarness.mount(16, 420);
    window.graphRefHarness.changeRow({ publishedTags: [tag] });
  }, { ...publishedTag, name: "v-offscreen" });
  const summary = page.getByRole("button", { name: "Browse 12 refs at 0000000" });
  await summary.press("Enter");
  const panel = page.locator(".ref-browser-panel");
  const action = panel.getByRole("button", { name: /^origin's v-offscreen points here/ });
  await action.focus();
  await panel.evaluate((list) => { list.scrollTop = 32; });
  await settle();
  await expect(panel).toHaveCount(1);
  await expect(action).toBeFocused();
  const scroll = page.locator(".graph-scroll");
  await scroll.evaluate((view) => { view.scrollTop = 240; });
  await expect(panel).toHaveCount(0, { timeout: 1500 });
  await expect(summary).not.toBeFocused();
  expect(await scroll.evaluate((view) => view.scrollTop)).toBe(240);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.graphRefHarness.lastAction())).not.toBe("tag:v-offscreen");
});

test("compact rows keep moved tags, stack positions and worktree actions in the ref list", async () => {
  await page.evaluate(() => {
    window.graphRefHarness.prepareDeepScene(175, 7);
    window.graphRefHarness.remount();
  });
  const stackRow = page.locator('.graph-row[data-hash="0000006"]');
  await stackRow.getByRole("button", { name: "Browse 11 refs at 0000006" }).press("Enter");
  const stackList = stackRow.getByRole("region");
  await expect(stackList).toContainText("#7");
  await stackList.getByRole("button", { name: /^Open stack for feature/ }).press("Enter");
  await expect(stackList).toBeHidden();
  expect(await page.evaluate(() => window.graphRefHarness.lastAction())).toBe("stack:widget-stack-6");

  await page.evaluate(() => {
    const harness = window.graphRefHarness;
    harness.mount(1, 276);
    harness.changeBranch(true, true);
    const local = { kind: "lightweight" as const, targetId: "old", objectId: "a" };
    harness.changeRow({ isHead: true, publishedTags: ["v7", "v8"].map((name) => ({
      name, local, published: { ...local, remote: "origin", targetId: "new" }
    })) });
  });
  const summary = page.getByRole("button", { name: "Browse 13 refs at 0000000" });
  const list = page.getByRole("region", { name: "Refs at 0000000" });
  await summary.press("Enter");
  await expect(list.getByRole("listitem")).toHaveCount(13);
  await list.getByRole("button", { name: /^origin's v8 points here/ }).press("Enter");
  await expect(list).toBeHidden();
  expect(await page.evaluate(() => window.graphRefHarness.lastAction())).toBe("tag:v8");
  await summary.press("Enter");
  const worktree = list.getByRole("button", { name: /^Open the feature/ });
  await expect(worktree).toBeVisible({ timeout: 1500 });
  await worktree.press("Enter");
  await expect(list).toBeHidden();
  expect(await page.evaluate(() => window.graphRefHarness.lastAction())).toBe("worktree:widget-checkout");
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
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const metrics = async () => Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])
    );
    const cases = [24, 120].flatMap((count) => [800, 420].map((width) => ({ count, width })));
    const fits = new Map<string, string>();
    const initialization = new Map<string, string>();
    for (let sample = 0; sample < 13; sample++) {
      for (const { count, width } of sample % 2 === 0 ? cases : [...cases].reverse()) {
        // The deep viewport ends after the 24th row: 1px of card border,
        // 24 × 64px, and the harness's 16px reservation. A scene with
        // only 24 rows keeps its original room for padding and scrollbars.
        await page.setViewportSize({ width: 900, height: count === 120 ? 1553 : 1620 });
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
          // Compare the same commits, lane SVGs, subjects, ages, bylines, and
          // viewport independently of the deliberately different ref preview.
          const scene = await page.evaluate(() => {
            const scroll = document.querySelector(".graph-scroll")!.getBoundingClientRect();
            const all = [...document.querySelectorAll(".graph-row")];
            return {
              pane: document.querySelector(".graph-harness")!.getBoundingClientRect().width,
              monoLoaded: document.fonts.check('600 9.5px "Geist Mono"'),
              visible: all.filter(row => row.getBoundingClientRect().top < scroll.bottom).length,
              fullyVisible: all.filter(row => row.getBoundingClientRect().bottom <= scroll.bottom).length,
              rows: all.map(row => [
                row.getAttribute("data-hash"), row.querySelector(".graph-lanes")!.outerHTML,
                ...[".commit-sha-chip", ".commit-msg", ".commit-time", ".commit-author"]
                  .map(selector => row.querySelector(selector)!.textContent)
              ])
            };
          });
          expect(scene).toMatchObject({ pane: width, monoLoaded: true, visible: 24, fullyVisible: 24 });
          expect(scene.rows).toHaveLength(count);
          const key = `${count}:${width}`;
          const initialized = createHash("sha256").update(JSON.stringify(scene)).digest("hex").slice(0, 12);
          if (!initialization.has(key)) initialization.set(key, initialized);
          expect(initialized).toBe(initialization.get(key));
          const rows = await readRows();
          if (version.name === "current") expect(rows.flatMap(row => row.clipped)).toEqual([]);
          const fit = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 12);
          const fitKey = `${version.name}:${key}`;
          if (!fits.has(fitKey)) fits.set(fitKey, fit);
          expect(fit).toBe(fits.get(fitKey));
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
          if (version.name === "current") expect(geometryReads).toBe(0);
          // The first pass warms up the browser. Each sample still mounts into a new document.
          if (sample === 0) continue;
          console.log(JSON.stringify({
            version: version.name, sample, count, width, initialized, fit, wallMs, geometryReads,
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
  test("captures wide and compact ref previews", async () => {
    mkdirSync(shots, { recursive: true });
    const versions = [{ name: "after", html }];
    if (baselineHtml !== undefined) versions.unshift({ name: "before", html: baselineHtml });
    for (const version of versions) {
      for (const width of [700, 420, 276]) {
        await page.goto(pathToFileURL(version.html).href);
        await page.evaluate(async (w) => {
          await window.graphRefHarness.ready;
          window.graphRefHarness.mount(5, w);
        }, width);
        await settle();
        await page.locator(".graph-harness").screenshot({ path: join(shots, `${version.name}-${width}.png`) });
      }
    }
    await page.getByRole("button", { name: "Browse 11 refs at 0000000" }).click();
    await page.getByRole("region", { name: "Refs at 0000000" }).screenshot({ path: join(shots, "after-list.png") });
  });

  test("captures crowded refs and a published tag warning", async () => {
    mkdirSync(shots, { recursive: true });
    const versions = [{ name: "after", html }];
    if (baselineHtml !== undefined) versions.unshift({ name: "before", html: baselineHtml });
    for (const version of versions) {
      await page.goto(pathToFileURL(version.html).href);
      await page.evaluate(() => window.graphRefHarness.ready);
      await crowdedHead();
      await settle();
      await page.locator(".graph-harness").screenshot({ path: join(shots, `${version.name}-crowded.png`) });
      await page.evaluate((tag) => {
        window.graphRefHarness.resize(700);
        window.graphRefHarness.changeRow({ publishedTags: [tag] });
      }, publishedTag);
      await settle();
      await page.locator(".graph-harness").screenshot({ path: join(shots, `${version.name}-published.png`) });
    }
  });
}
