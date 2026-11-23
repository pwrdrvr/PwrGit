import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { toolbarFit } from "./harness/toolbar-fit/main";

declare global {
  interface Window {
    toolbarFit: typeof toolbarFit;
  }
}

const CASES = {
  lineage: {
    row: ".graph-toolbar",
    box: ".graph-toolbar",
    end: ".graph-toolbar__fit-end",
    steps: ["fit-locate-icon", "fit-count-mid", "fit-scope-short", "fit-count-short", "fit-no-label"],
    width: 257
  },
  worktree: {
    row: ".wt-header",
    box: ".wt-header__state",
    end: ".wt-header__fit-end",
    steps: ["fit-icons", "fit-chip-mid", "fit-chip-short", "fit-no-lfs", "fit-no-chip", "fit-no-drift", "fit-no-readonly"],
    width: 330
  },
  sidebar: {
    row: ".sidebar-toolbar",
    box: ".sidebar-toolbar",
    end: ".sidebar-toolbar__icon",
    steps: ["sidebar-toolbar--add-icon", "sidebar-toolbar--icons"],
    width: 204
  }
};
type Toolbar = keyof typeof CASES;

let out: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  out = mkdtempSync(`${tmpdir()}/pwrgit-toolbar-fit-`);
  const html = await buildHarness("toolbar-fit", `${out}/dist`);
  app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      fileURLToPath(new URL("./harness/electron-main.cjs", import.meta.url))
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html })
  });
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => "toolbarFit" in window);
  await page.evaluate(() => window.toolbarFit.ready);
});

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

async function waitForLayout(toolbar: Toolbar) {
  // Hidden windows can deliver frames at 1 Hz on CI. Wait for one actual
  // layout delivery, including the fit box's initial ResizeObserver pass.
  await page.locator(CASES[toolbar].box).evaluate((box) =>
    new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(box);
    })
  );
}

async function mount(toolbar: Toolbar, forkSource = false) {
  await page.evaluate(({ toolbar, width, forkSource }) => {
    window.toolbarFit.mount({ toolbar, width, forkSource, expanded: true, overflow: false });
  }, { toolbar, width: CASES[toolbar].width, forkSource });
  if (toolbar === "lineage") await expect(page.locator(".graph-locate")).toBeAttached();
  await waitForLayout(toolbar);
}

/** Try every presentation on a separate copy at the live width. The oracle
 *  keeps the current classes and observer state of the live row untouched. */
async function checkFit(toolbar: Toolbar) {
  const actual = await page.evaluate((config) => {
    const row = document.querySelector<HTMLElement>(config.row)!;
    const probe = row.cloneNode(true) as HTMLElement;
    const width = row.getBoundingClientRect().width;
    Object.assign(probe.style, { position: "absolute", visibility: "hidden", width: `${width}px` });
    probe.classList.remove(...config.steps);
    row.after(probe);
    try {
      const box = probe.matches(config.box) ? probe : probe.querySelector(config.box)!;
      const end = probe.querySelector(config.end)!;
      const style = getComputedStyle(box);
      const edge = box.getBoundingClientRect().right -
        parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
      let best = 0;
      for (const step of config.steps) {
        if (end.getBoundingClientRect().right <= edge + 0.5) break;
        probe.classList.add(step);
        best++;
      }
      return { expected: config.steps.slice(0, best),
        applied: config.steps.filter((step) => row.classList.contains(step)), width };
    } finally {
      probe.remove();
    }
  }, CASES[toolbar]);
  expect(actual.applied, `${toolbar} at ${actual.width}px`).toEqual(actual.expected);
  return { depth: actual.expected.length, width: actual.width };
}

async function resize(toolbar: Toolbar, width: number) {
  await page.locator(".toolbar-case").evaluate((parent, value) => {
    parent.style.width = `${value}px`;
  }, width);
  await waitForLayout(toolbar);
}

const photos = process.env["PWRGIT_HARNESS_SHOTS"];

for (const toolbar of ["lineage", "worktree", "sidebar"] as const) {
  test(`${toolbar} skips fit reads and step writes on equivalent commits`, async () => {
    await mount(toolbar);
    const actual = await page.evaluate(async (config) => {
      const row = document.querySelector(config.row)!;
      const original = window.getComputedStyle;
      let reads = 0;
      let writes = 0;
      const observer = new MutationObserver((changes) => { writes += changes.length; });
      observer.observe(row, { attributeFilter: ["class"] });
      window.getComputedStyle = (element, pseudo) => {
        if (element.matches(config.box)) reads++;
        return original(element, pseudo);
      };
      try {
        for (let tick = 1; tick <= 6; tick++) {
          window.toolbarFit.update({ tick });
          await Promise.resolve();
        }
        // Run after the mutation observers and any queued fit from the commits.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return { reads, writes };
      } finally {
        observer.disconnect();
        window.getComputedStyle = original;
      }
    }, CASES[toolbar]);
    expect(actual).toEqual({ reads: 0, writes: 0 });
  });

  test(`${toolbar} matches the widest fitting presentation through layout and content changes`, async () => {
    await mount(toolbar, toolbar === "worktree");
    const forkChip = page.locator(".sync-chip--source");
    if (toolbar === "worktree") {
      await expect(forkChip.locator(".sync-chip__text")).toHaveText("↓812 behind upstream-widget-automation");
      await expect(forkChip).toHaveAttribute("data-mid", "↓812 upstream-widget-automation");
      await expect(forkChip).toHaveAttribute("data-short", "↓812");
    }
    const base = CASES[toolbar].width;
    // The fork's long remote name needs wider cases for the full and mid labels.
    const widths = toolbar === "worktree"
      ? [740, 615, 595, 465, 395, 354, 330, 318]
      : [base + 135, base + 100, base + 65, base + 40, base + 24, base, base - 12];
    const depths = new Set<number>();
    let respondsToContent = false;
    let respondsToScrollbar = false;
    let respondsToScale = false;
    for (const width of widths) {
      // External parent resize alone, with no React commit.
      await resize(toolbar, width);
      const initial = await checkFit(toolbar);
      depths.add(initial.depth);
      await page.evaluate(() => window.toolbarFit.update({ expanded: false }));
      if (toolbar === "lineage") await expect(page.locator(".graph-locate")).toHaveCount(0);
      if (toolbar === "worktree") await expect(forkChip).toHaveCount(0);
      const compact = await checkFit(toolbar);
      expect(compact.width).toBe(initial.width);
      respondsToContent ||= compact.depth !== initial.depth;

      await page.evaluate(() => window.toolbarFit.update({ overflow: true }));
      await waitForLayout(toolbar);
      const scrolled = await checkFit(toolbar);
      expect(scrolled.width).toBeLessThan(compact.width);
      respondsToScrollbar ||= compact.depth !== scrolled.depth;

      await page.evaluate(() => window.toolbarFit.scale(true));
      const scaled = await checkFit(toolbar);
      expect(scaled.width).toBe(scrolled.width);
      respondsToScale ||= scaled.depth !== scrolled.depth;

      await page.evaluate(() => {
        window.toolbarFit.scale(false);
        window.toolbarFit.update({ width: document.querySelector(".toolbar-case")!.getBoundingClientRect().width,
          expanded: true, overflow: false });
      });
      if (toolbar === "lineage") await expect(page.locator(".graph-locate")).toBeAttached();
      if (toolbar === "worktree") await expect(forkChip).toBeAttached();
      await waitForLayout(toolbar);
      expect(await checkFit(toolbar)).toEqual(initial);
    }
    expect(depths.size).toBeGreaterThan(1);
    if (toolbar === "worktree") {
      expect(depths.has(0) || depths.has(1), "full fork-source label").toBe(true);
      expect(depths.has(2), "mid fork-source label").toBe(true);
      expect(depths.has(3), "short fork-source label").toBe(true);
    }
    expect(respondsToContent).toBe(true);
    expect(respondsToScrollbar).toBe(true);
    expect(respondsToScale).toBe(true);
  });
}

test("refits when the child-owned Git LFS chip changes at a fixed width", async () => {
  let changed = false;
  for (const width of [305, 325, 345, 365, 385, 405, 425, 445]) {
    await page.evaluate((width) =>
      window.toolbarFit.mount({ toolbar: "worktree", width, expanded: true, overflow: false }), width);
    await waitForLayout("worktree");
    const before = await checkFit("worktree");
    await page.evaluate(() => window.toolbarFit.finishLfsRead());
    await expect(page.locator(".lfs-chip")).toBeAttached();
    if (photos !== undefined && width === 365) {
      mkdirSync(photos, { recursive: true });
      await page.locator(".toolbar-case").screenshot({ path: join(photos, "worktree-lfs.png") });
    }
    const withLfs = await checkFit("worktree");
    expect(withLfs.width).toBe(before.width);
    changed ||= withLfs.depth !== before.depth;
  }
  expect(changed).toBe(true);
});

test("refits at the same width when a pending font becomes available", async () => {
  await mount("sidebar");
  await page.evaluate(() => window.toolbarFit.useLateFont());
  // The initial no-step threshold is measured in the fallback face.
  let tooNarrow = CASES.sidebar.width - 1;
  let wideEnough = 330;
  while (wideEnough - tooNarrow > 1) {
    const width = Math.floor((tooNarrow + wideEnough) / 2);
    await resize("sidebar", width);
    if ((await checkFit("sidebar")).depth === 0) wideEnough = width;
    else tooNarrow = width;
  }
  await resize("sidebar", wideEnough);
  const fallback = await checkFit("sidebar");
  expect(fallback.depth).toBe(0);
  await page.evaluate(async () => {
    const finished = new Promise<void>((resolve) => {
      const onFontsLoaded = (event: FontFaceSetLoadEvent) => {
        if (!event.fontfaces.some((face) => face.family.includes("Toolbar Fit Wide"))) return;
        document.fonts.removeEventListener("loadingdone", onFontsLoaded);
        resolve();
      };
      document.fonts.addEventListener("loadingdone", onFontsLoaded);
    });
    await Promise.all([window.toolbarFit.loadWideFont(), finished]);
  });
  const loaded = await checkFit("sidebar");
  expect(loaded.width).toBe(fallback.width);
  expect(loaded.depth).toBeGreaterThan(fallback.depth);
});

test("same-column sync reports leave the sidebar fit alone", async () => {
  await mount("sidebar");
  await page.evaluate(() => window.toolbarFit.update({ progress: { completed: 10, inFlight: 2 } }));
  const fit = await checkFit("sidebar");
  const results = await page.evaluate(async (config) => {
    const count = document.querySelector(".sidebar-toolbar__count")!;
    const width = count.getBoundingClientRect().width;
    const computedStyle = window.getComputedStyle;
    let reads = 0;
    window.getComputedStyle = (element, pseudo) => {
      if (element.matches(config.box)) reads++;
      return computedStyle(element, pseudo);
    };
    try {
      const samples = [];
      for (let completed = 10; completed <= 40; completed++) {
        window.toolbarFit.update({ progress: { completed, inFlight: completed % 2 === 0 ? 1 : 2 } });
        await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
        samples.push({
          reads, count: count.textContent, sameWidth: count.getBoundingClientRect().width === width
        });
      }
      return samples;
    } finally {
      window.getComputedStyle = computedStyle;
    }
  }, CASES.sidebar);
  expect(results).toEqual(Array.from({ length: 31 }, (_, index) => ({
    reads: 0, count: `${10 + index}/42`, sameWidth: true
  })));
  expect(await checkFit("sidebar")).toEqual(fit);
});

test("a sync report with a longer count can change the fit without a resize", async () => {
  await mount("sidebar");
  const report = (completed: number) => page.evaluate((value) => {
    window.toolbarFit.update({ progress: { completed: value, inFlight: 2 } });
  }, completed);
  await report(9);
  let tooNarrow = CASES.sidebar.width - 1;
  let wideEnough = 395;
  while (wideEnough - tooNarrow > 1) {
    const width = Math.floor((tooNarrow + wideEnough) / 2);
    await resize("sidebar", width);
    if ((await checkFit("sidebar")).depth === 0) wideEnough = width;
    else tooNarrow = width;
  }
  await resize("sidebar", wideEnough);
  const before = await checkFit("sidebar");
  expect(before.depth).toBe(0);
  await report(10);
  const after = await checkFit("sidebar");
  expect(after.width).toBe(before.width);
  expect(after.depth).toBeGreaterThan(before.depth);
  await report(9);
  expect(await checkFit("sidebar")).toEqual(before);
});

test("the out-of-flow branch navigator opens and closes without refitting the toolbar", async () => {
  await mount("lineage");
  const trigger = page.locator(".graph-branches");
  const menu = page.getByRole("menu");
  const results = await page.evaluate(async (config) => {
    const computedStyle = window.getComputedStyle;
    let reads = 0;
    window.getComputedStyle = (element, pseudo) => {
      if (element.matches(config.box)) reads++;
      return computedStyle(element, pseudo);
    };
    const trigger = document.querySelector<HTMLButtonElement>(".graph-branches")!;
    try {
      const samples = [];
      for (let index = 0; index < 5; index++) {
        trigger.click();
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        samples.push({ reads, open: document.querySelector(".branch-pop") !== null });
      }
      return samples;
    } finally {
      window.getComputedStyle = computedStyle;
    }
  }, CASES.lineage);
  expect(results).toEqual(Array.from({ length: 5 }, (_, index) => ({ reads: 0, open: index % 2 === 0 })));
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(menu).toHaveCount(0);
  await checkFit("lineage");
});

if (photos !== undefined) {
  test("captures live sync and the branch navigator", async () => {
    mkdirSync(photos, { recursive: true });
    await mount("sidebar");
    await page.evaluate(() => window.toolbarFit.update({ progress: { completed: 18, inFlight: 2 } }));
    await waitForLayout("sidebar");
    await page.locator(CASES.sidebar.row).screenshot({ path: join(photos, "sidebar-live.png") });
    await mount("lineage");
    await resize("lineage", 540);
    await page.locator(".graph-branches").press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    const capture = page.locator(".toolbar-case");
    const insets = await capture.evaluate((frame) => {
      const menu = frame.querySelector(".branch-pop")!.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const left = frameRect.left + frame.clientLeft;
      const top = frameRect.top + frame.clientTop;
      return [
        menu.left - left,
        menu.top - top,
        left + frame.clientWidth - menu.right,
        top + frame.clientHeight - menu.bottom
      ];
    });
    expect(Math.min(...insets), `Branch menu insets (left, top, right, bottom): ${insets.join(", ")}`)
      .toBeGreaterThanOrEqual(0);
    await capture.screenshot({ path: join(photos, "lineage-menu.png") });
  });
}

for (const toolbar of ["lineage", "worktree", "sidebar"] as const) {
  test(`benchmark each toolbar in isolation (${toolbar})`, async () => {
    test.skip(process.env["PWRGIT_FIT_BENCH"] !== "1", "Opt-in browser profiling");
    // The 172 resizes with tracing can each take two frames. Budget for 1 Hz
    // hidden windows, including the timers used by the Lineage content workload.
    test.setTimeout(20 * 60_000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const traceDirectory = process.env["PWRGIT_FIT_TRACE"];
    const readMetrics = async () => Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])
    );
    await mount(toolbar);
    if (photos !== undefined) {
      mkdirSync(photos, { recursive: true });
      await resize(toolbar, CASES[toolbar].width + 24);
      await page.locator(CASES[toolbar].row).screenshot({ path: join(photos, `${toolbar}.png`) });
      await resize(toolbar, CASES[toolbar].width);
    }
    for (const workload of ["unchanged", "content", "width", "display"] as const) {
      if (workload === "display" && toolbar === "worktree") continue;
      if (workload === "display" && toolbar === "sidebar") {
        await page.evaluate(() => window.toolbarFit.update({ expanded: true, progress: { completed: 10, inFlight: 2 } }));
        await waitForLayout(toolbar);
      }
      const run = (count: number) => page.evaluate(async ({ count, workload, config, toolbar }) => {
        const row = document.querySelector(config.row)!;
        const classes = row.classList;
        const originalStyle = window.getComputedStyle;
        const add = classes.add;
        const remove = classes.remove;
        let reads = 0, writes = 0;
        window.getComputedStyle = (element, pseudo) => {
          if (element.matches(config.box)) reads++;
          return originalStyle(element, pseudo);
        };
        classes.add = (...tokens) => { writes++; add.apply(classes, tokens); };
        classes.remove = (...tokens) => { writes++; remove.apply(classes, tokens); };
        try {
          for (let i = 0; i < count; i++) {
            const alternate = i % 2 === 0;
            if (workload === "unchanged") {
              window.toolbarFit.update({ tick: i });
              await Promise.resolve();
              await Promise.resolve();
            } else if (workload === "content") {
              window.toolbarFit.update({ expanded: alternate });
              if (toolbar === "lineage") {
                // The fake graph and author reads resolve through async effects.
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
              } else {
                await Promise.resolve();
                await Promise.resolve();
              }
            } else {
              if (workload === "width") {
                row.closest<HTMLElement>(".toolbar-case")!.style.width = `${config.width + (alternate ? 130 : 0)}px`;
              } else if (toolbar === "lineage") {
                row.querySelector<HTMLButtonElement>(".graph-branches")!.click();
              } else {
                window.toolbarFit.update({ progress: { completed: 11 + i % 30, inFlight: 2 } });
              }
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              );
            }
          }
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
          return { reads, writes, steps: classes.value };
        } finally {
          window.getComputedStyle = originalStyle;
          delete (classes as Partial<DOMTokenList>).add;
          delete (classes as Partial<DOMTokenList>).remove;
        }
      }, { count, config: CASES[toolbar], workload, toolbar });
      await run(10);
      const count = workload === "width" || workload === "display" ? 30 : 100;
      for (let sample = 0; sample < 5; sample++) {
        const before = await readMetrics();
        const result = await run(count);
        const after = await readMetrics();
        const delta = (name: string, scale = 1) =>
          +((after[name]! - before[name]!) * scale).toFixed(3);
        console.log(JSON.stringify({ toolbar, workload, count, ...result,
          layouts: delta("LayoutCount"), styles: delta("RecalcStyleCount"),
          layoutMs: delta("LayoutDuration", 1000), styleMs: delta("RecalcStyleDuration", 1000),
          taskMs: delta("TaskDuration", 1000)
        }));
      }
      if (traceDirectory !== undefined) {
        mkdirSync(traceDirectory, { recursive: true });
        const events: unknown[] = [];
        const collect = ({ value }: { value: unknown[] }) => {
          for (const event of value) events.push(event);
        };
        cdp.on("Tracing.dataCollected", collect);
        await cdp.send("Tracing.start", {
          categories: "devtools.timeline,disabled-by-default-devtools.timeline.stack"
        });
        await run(12);
        const finished = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
        await cdp.send("Tracing.end");
        await finished;
        cdp.off("Tracing.dataCollected", collect);
        writeFileSync(join(traceDirectory, `${toolbar}-${workload}.json`), JSON.stringify(events));
      }
    }
    await cdp.detach();
  });
}
