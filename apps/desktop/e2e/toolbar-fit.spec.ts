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

async function settle() {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ));
}

async function mount(toolbar: Toolbar) {
  await page.evaluate(({ toolbar, width }) => {
    window.toolbarFit.mount({ toolbar, width, expanded: true, overflow: false });
  }, { toolbar, width: CASES[toolbar].width });
  if (toolbar === "lineage") await expect(page.locator(".graph-locate")).toBeAttached();
  await settle();
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

async function resize(width: number) {
  await page.locator(".toolbar-case").evaluate((parent, value) => {
    parent.style.width = `${value}px`;
  }, width);
  await settle();
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
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        return { reads, writes };
      } finally {
        observer.disconnect();
        window.getComputedStyle = original;
      }
    }, CASES[toolbar]);
    expect(actual).toEqual({ reads: 0, writes: 0 });
  });

  test(`${toolbar} matches the widest fitting presentation through layout and content changes`, async () => {
    await mount(toolbar);
    const base = CASES[toolbar].width;
    const depths = new Set<number>();
    let respondsToContent = false;
    let respondsToScrollbar = false;
    let respondsToScale = false;
    for (const width of [base + 135, base + 100, base + 65, base + 40, base + 24, base, base - 12]) {
      // External parent resize alone, with no React commit.
      await resize(width);
      const initial = await checkFit(toolbar);
      depths.add(initial.depth);
      await page.evaluate(async () => {
        window.toolbarFit.update({ expanded: false });
        if (document.querySelector(".graph-toolbar") !== null) {
          // Fake IPC and the effects publishing the new graph are async.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      if (toolbar === "lineage") await expect(page.locator(".graph-locate")).toHaveCount(0);
      const compact = await checkFit(toolbar);
      expect(compact.width).toBe(initial.width);
      respondsToContent ||= compact.depth !== initial.depth;

      await page.evaluate(() => window.toolbarFit.update({ overflow: true }));
      await settle();
      const scrolled = await checkFit(toolbar);
      expect(scrolled.width).toBeLessThan(compact.width);
      respondsToScrollbar ||= compact.depth !== scrolled.depth;

      await page.evaluate(() => window.toolbarFit.scale(true));
      await settle();
      const scaled = await checkFit(toolbar);
      expect(scaled.width).toBe(scrolled.width);
      respondsToScale ||= scaled.depth !== scrolled.depth;

      await page.evaluate(() => {
        window.toolbarFit.scale(false);
        window.toolbarFit.update({ width: document.querySelector(".toolbar-case")!.getBoundingClientRect().width,
          expanded: true, overflow: false });
      });
      if (toolbar === "lineage") await expect(page.locator(".graph-locate")).toBeAttached();
      await settle();
      expect(await checkFit(toolbar)).toEqual(initial);
    }
    expect(depths.size).toBeGreaterThan(1);
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
    await settle();
    const before = await checkFit("worktree");
    await page.evaluate(() => window.toolbarFit.finishLfsRead());
    await expect(page.locator(".lfs-chip")).toBeAttached();
    await settle();
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
  for (let width = 208; width <= 330; width += 2) {
    await resize(width);
    if ((await checkFit("sidebar")).depth === 0) break;
  }
  const fallback = await checkFit("sidebar");
  expect(fallback.depth).toBe(0);
  await page.evaluate(() => window.toolbarFit.loadWideFont());
  await settle();
  const loaded = await checkFit("sidebar");
  expect(loaded.width).toBe(fallback.width);
  expect(loaded.depth).toBeGreaterThan(fallback.depth);
});

test("benchmark each toolbar in isolation", async () => {
  test.skip(process.env["PWRGIT_FIT_BENCH"] !== "1", "Opt-in browser profiling");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  const traceDirectory = process.env["PWRGIT_FIT_TRACE"];
  const readMetrics = async () => Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])
  );
  for (const toolbar of ["lineage", "worktree", "sidebar"] as const) {
    await mount(toolbar);
    if (photos !== undefined) {
      mkdirSync(photos, { recursive: true });
      await resize(CASES[toolbar].width + 24);
      await page.locator(CASES[toolbar].row).screenshot({ path: join(photos, `${toolbar}.png`) });
      await resize(CASES[toolbar].width);
    }
    for (const workload of ["unchanged", "content", "width"] as const) {
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
              row.closest<HTMLElement>(".toolbar-case")!.style.width = `${config.width + (alternate ? 130 : 0)}px`;
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
      const count = workload === "width" ? 30 : 100;
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
  }
});
