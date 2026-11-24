import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test as base, type CDPSession, type ElectronApplication, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { bulkSyncPaint } from "./harness/bulk-sync-paint/main";

declare global {
  interface Window {
    bulkSyncPaint: typeof bulkSyncPaint;
  }
}

const test = base.extend<{ manualWindow: boolean; harness: { app: ElectronApplication; page: Page } }>({
  manualWindow: [false, { option: true }],
  harness: async ({ manualWindow }, use) => {
    const out = mkdtempSync(join(tmpdir(), "pwrgit-bulk-sync-paint-"));
    try {
      const html = await buildHarness("bulk-sync-paint", join(out, "dist"), manualWindow);
      const app = await electron.launch({
        args: [
          "--disable-accelerated-video-decode",
          "--disable-accelerated-video-encode",
          ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
          fileURLToPath(new URL("./harness/electron-main.cjs", import.meta.url))
        ],
        env: cleanEnv({
          PWRGIT_HARNESS_HTML: html,
          PWRGIT_HARNESS_WIDTH: manualWindow ? "1360" : "320",
          PWRGIT_HARNESS_HEIGHT: manualWindow ? "860" : "680"
        })
      });
      try {
        const page = await app.firstWindow();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await use({ app, page });
      } finally {
        await app.close();
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});
const manualTest = test.extend({ manualWindow: true });

const toolbarBar = ".sidebar-toolbar__progress";
const inFlight = `${toolbarBar} > .is-in-flight`;
const progressCount = ".sidebar-toolbar__count";
const toast = ".bulk-sync-toast";
const toastBar = ".bulk-sync-toast__bar";
const toastInFlight = `${toastBar} > .is-in-flight`;

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => "bulkSyncPaint" in window);
  await page.evaluate(() => window.bulkSyncPaint.ready);
  await expect(page.getByRole("button", { name: "Try pull all" })).toBeEnabled();
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function start(page: Page): Promise<void> {
  await page.evaluate(() => window.bulkSyncPaint.start());
  await expect(page.locator(progressCount)).toHaveText("0/30");
}

test("the automatic pull's sidebar stripes stay still as outcomes accumulate", async ({ harness: { page } }) => {
  await ready(page);
  await start(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try pull all" })).toHaveAttribute("aria-busy", "true");
  const segment = page.locator(inFlight);
  for (const [from, to] of [[0, 1], [1, 6], [6, 28]] as const) {
    await page.evaluate(([first, end]) => {
      for (let i = first; i < end; i++) window.bulkSyncPaint.complete(i, false);
    }, [from, to]);
    await expect(page.locator(progressCount)).toHaveText(`${to}/30`);
    await expect(segment).not.toHaveClass(/\bis-empty\b/);
    await expect(segment).toHaveCSS("background-image", /^repeating-linear-gradient\(/);
    // Chromium is the oracle here. A settled in-flight segment should have
    // a visible pattern with no CSS animation scheduling further paints.
    expect(await segment.evaluate((node) =>
      node.getAnimations().filter((animation) => animation instanceof CSSAnimation).length
    )).toBe(0);
  }
  await expect(page.locator(`${toolbarBar} > .is-success`)).toHaveCSS("flex-grow", "27");
  await expect(page.locator(`${toolbarBar} > .is-skipped`)).toHaveCSS("flex-grow", "1");
  await expect(segment).toHaveCSS("flex-grow", "2");

  await page.getByRole("button", { name: "Try pull all" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The larger status bar still animates when a user opens the run.
  await expect(dialog.locator(".bulk-sync__bar > .is-in-flight")).toHaveCSS("animation-name", "bulk-sync-stripes");
});

const shots = process.env["PWRGIT_HARNESS_SHOTS"];
if (shots !== undefined) {
  test("captures the automatic pull on the sync face", async ({ harness: { page } }) => {
    await ready(page);
    await start(page);
    await page.evaluate(() => {
      for (let i = 0; i < 12; i++) window.bulkSyncPaint.complete(i, false);
    });
    await expect(page.locator(progressCount)).toHaveText("12/30");
    await expect(page.locator(`${toolbarBar} > .is-success`)).toHaveCSS("flex-grow", "11");
    // Freeze the before image at the same stripe phase as the stationary bar.
    const toolbar = page.locator(".sidebar-toolbar");
    await toolbar.evaluate((row) => {
      for (const animation of row.getAnimations({ subtree: true })) {
        if (!(animation instanceof CSSAnimation)) continue;
        animation.pause();
        animation.currentTime = 0;
      }
    });
    mkdirSync(shots, { recursive: true });
    await toolbar.screenshot({ path: join(shots, "automatic-pull.png") });
  });
}

async function manualReady(page: Page) {
  const url = new URL(page.url());
  url.search = "manual";
  await page.goto(url.href);
  await page.waitForFunction(() => "bulkSyncPaint" in window);
  await page.evaluate(() => window.bulkSyncPaint.ready);
  const face = page.getByRole("button", { name: "Try pull recent", exact: true });
  await expect(face).toBeEnabled();
  const repo = page.getByRole("treeitem", { name: "widget-01", exact: true });
  await repo.click();
  await expect(repo).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  await expect(page.getByText("Worktree is clean.", { exact: true })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.mouse.move(2, 2);
}

async function startManual(page: Page) {
  await page.getByRole("button", { name: "Try pull recent", exact: true }).click();
  // The toolbar's hover card draws its own outcome bar. Keep it outside the
  // sample so its animation cannot masquerade as the collapsed toast's.
  await page.mouse.move(2, 2);
  await page.evaluate(() => window.bulkSyncPaint.start());
  await expect(page.locator(progressCount)).toHaveText("0/30");
  await expect(page.locator(toast)).toBeVisible();
}

manualTest("collapsed Pull Recent updates both compact bars without animating their segments", async ({ harness: { page } }) => {
  await manualReady(page);
  await startManual(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(toast).getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  const segment = page.locator(toastInFlight);
  for (const completed of [0, 1, 2]) {
    if (completed > 0) {
      await page.evaluate((index) => window.bulkSyncPaint.complete(index, false, 2), completed);
    }
    await expect(page.locator(progressCount)).toHaveText(`${completed}/30`);
    await expect(segment).not.toHaveClass(/\bis-empty\b/);
    await expect(segment).toHaveCSS("background-image", /^repeating-linear-gradient\(/);
    expect(await segment.evaluate((node) =>
      node.getAnimations().filter((animation) => animation instanceof CSSAnimation).length
    )).toBe(0);
    for (const bar of [toastBar, toolbarBar]) {
      const success = page.locator(`${bar} > .is-success`);
      expect(await success.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe("none");
      await expect(success).toHaveCSS("flex-grow", String(completed));
    }
  }
  await page.evaluate(() => {
    window.bulkSyncPaint.worktreeProgress(0, 0);
    window.bulkSyncPaint.worktreeProgress(0, 1);
  });
  await expect(page.locator(progressCount)).toHaveText("2/30");
  await page.locator(toast).getByRole("button", { name: "Show details" }).press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".bulk-sync__bar > .is-in-flight")).toHaveCSS("animation-name", "bulk-sync-stripes");
  await expect(dialog.locator(".bulk-sync__bar > .is-success")).toHaveCSS("transition-property", "flex-grow");
  await expect(dialog.getByText("2 of 211 worktrees checked", { exact: true })).toBeVisible();
  await expect(dialog.getByText("task-1: Checking for uncommitted changes…", { exact: true })).toBeVisible();
});

if (shots !== undefined) {
  manualTest("captures collapsed Pull Recent", async ({ harness: { page } }) => {
    await manualReady(page);
    await startManual(page);
    await page.evaluate(() => {
      for (let i = 0; i < 12; i++) window.bulkSyncPaint.complete(i, false);
    });
    await expect(page.locator(progressCount)).toHaveText("12/30");
    await expect(page.locator(`${toastBar} > .is-success`)).toHaveCSS("flex-grow", "11");
    // Sample a fixed mid-cycle phase in the baseline screenshot.
    await page.locator(toastInFlight).evaluate((bar) => {
      for (const animation of bar.getAnimations()) {
        if (!(animation instanceof CSSAnimation)) continue;
        animation.pause();
        animation.currentTime = 400;
      }
    });
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "pull-recent.png") });
  });
}

type TraceEvent = {
  name: string; pid: number; ts: number; dur?: number; tdur?: number; ph: string;
  args?: { data?: { nodeName?: string } };
};

const readCpu = (electronApp: ElectronApplication) => electronApp.evaluate(({ app, BrowserWindow }) => {
  const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
  const metrics = app.getAppMetrics();
  const renderer = metrics.find((metric) => metric.pid === pid)?.cpu.cumulativeCPUUsage;
  if (renderer === undefined) throw new Error("No renderer CPU counter");
  return { pid, renderer, gpu: metrics.find((metric) => metric.type === "GPU")?.cpu.cumulativeCPUUsage ?? 0 };
});
const readMetrics = async (cdp: CDPSession) => Object.fromEntries(
  (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])
);

function paintArea(nodeName = ""): string {
  if (nodeName === "#document") return "document";
  if (nodeName.includes("bulk-sync-toast")) return "toast";
  if (nodeName.includes("sidebar-toolbar")) return "toolbar";
  if (nodeName.includes("graph-")) return "lineage";
  if (/sidebar__|repo-row|wt-row/u.test(nodeName)) return "repoTree";
  return "other";
}

const benchmark = process.env["PWRGIT_BULK_PAINT_BENCH"] === "1" ? test : test.skip;
const manualBenchmark = process.env["PWRGIT_BULK_TOAST_BENCH"] === "1" ? manualTest : manualTest.skip;
manualBenchmark("measures collapsed Pull Recent by phase", async ({ harness: { app, page } }) => {
  test.setTimeout(360_000);
  const cases = [
    "baseline", "static", "no-toast-flex", "static-no-toast-flex", "static-no-compact-flex",
    "no-detail", "no-invalidation", "steady", "steady-static", "idle"
  ] as const;
  const traceDir = process.env["PWRGIT_BULK_TOAST_TRACE_DIR"];
  if (traceDir !== undefined) mkdirSync(traceDir, { recursive: true });
  for (let sample = 0; sample < 3; sample++) {
    for (const scenario of sample % 2 === 0 ? cases : [...cases].reverse()) {
      await manualReady(page);
      const steady = scenario === "steady" || scenario === "steady-static";
      const staticStripe = scenario === "steady-static" || scenario.startsWith("static");
      const noFlex = scenario.includes("flex");
      await page.addStyleTag({ content: `
        ${toastInFlight}:not(.is-empty) { animation: ${staticStripe ? "none" : "bulk-sync-stripes 900ms linear infinite"}; }
        .bulk-sync__bar${toastBar} > i { transition: ${noFlex ? "none" : "flex-grow 320ms ease"}; }
        .bulk-sync__bar${toolbarBar} > i { transition: ${scenario === "static-no-compact-flex" ? "none" : "flex-grow 320ms ease"}; }
      ` });
      if (steady) await startManual(page);
      await page.waitForTimeout(450);

      const cdp = await page.context().newCDPSession(page);
      const events: TraceEvent[] = [];
      cdp.on("Tracing.dataCollected", ({ value }) => {
        for (const event of value) events.push(event as unknown as TraceEvent);
      });
      await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
      await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,cc,viz" });
      const probe = async (phase: string) => {
        await page.evaluate((name) => performance.mark(`pull-recent-${name}`), phase);
        return {
          phase, cpu: await readCpu(app), time: performance.now(), metrics: await readMetrics(cdp)
        };
      };
      const marks = [await probe("start")];
      if (steady || scenario === "idle") {
        await page.waitForTimeout(2_000);
      } else {
        await startManual(page);
        const delivery = page.evaluate((scenario) => window.bulkSyncPaint.manualWorkload({
          detail: scenario !== "no-detail", invalidate: scenario !== "no-invalidation"
        }), scenario);
        await page.waitForTimeout(2_000);
        marks.push(await probe("after-onset"));
        await delivery;
        await expect(page.locator(progressCount)).toHaveText("29/30");
        await expect(page.locator(toast).getByRole("status")).toHaveText("Checking widget-01");
        marks.push(await probe("last-repo"));
        await page.waitForTimeout(850);
        marks.push(await probe("finishing"));
        await page.evaluate((invalidate) => window.bulkSyncPaint.complete(0, invalidate, 0), scenario !== "no-invalidation");
        await expect(page.locator(progressCount)).toHaveText("30/30");
        await expect(page.locator(toast).getByRole("status")).toHaveText("Finishing…");
        await page.waitForFunction(() => window.bulkSyncPaint.refreshesCommitted);
        if (scenario !== "no-invalidation") {
          await expect(page.getByText("Publish the widget catalog", { exact: true })).toBeVisible();
        }
        await page.waitForTimeout(550);
        marks.push(await probe("receipt"));
        await page.evaluate(() => window.bulkSyncPaint.finish());
        await expect(page.locator(progressCount)).toHaveCount(0);
        await expect(page.locator(toast).getByRole("status")).toHaveText("Pulled 29 of 30 repositories");
        await page.waitForTimeout(400);
      }
      marks.push(await probe("end"));
      const delivery = await page.evaluate(() => window.bulkSyncPaint.delivery);
      if (!steady && scenario !== "idle") {
        const invalidates = scenario !== "no-invalidation";
        expect(delivery.completed).toBe(30);
        expect(delivery.targetedReads).toBe(invalidates ? 29 : 0);
        expect(delivery.graphReads).toBe(invalidates ? 1 : 0);
        expect(delivery.changesReads).toBe(invalidates ? 1 : 0);
        expect(delivery.detailEvents).toBe(scenario === "no-detail" ? 0 : 509);
      }
      const finished = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
      await cdp.send("Tracing.end");
      await finished;
      await cdp.detach();
      if (traceDir !== undefined) writeFileSync(join(traceDir, `${scenario}-${sample}.json`), JSON.stringify({ traceEvents: events }));
      const round = (value: number) => +value.toFixed(2);
      for (const [i, to] of marks.slice(1).entries()) {
        const from = marks[i]!;
        expect(to.cpu.pid).toBe(from.cpu.pid);
        const start = events.find((event) => event.name === `pull-recent-${from.phase}`)?.ts;
        const end = events.find((event) => event.name === `pull-recent-${to.phase}`)?.ts;
        expect(start).toBeDefined();
        expect(end).toBeGreaterThan(start!);
        const rendererEvents = events.filter((event) =>
          event.pid === from.cpu.pid && event.ts >= start! && event.ts < end!
        );
        const paints = rendererEvents.filter((event) => event.name === "Paint" && event.ph === "X");
        const paintsByNode: Record<string, number> = {};
        for (const event of paints) {
          const area = paintArea(event.args?.data?.nodeName);
          paintsByNode[area] = (paintsByNode[area] ?? 0) + 1;
        }
        const delta = (name: string, scale = 1) => round((to.metrics[name]! - from.metrics[name]!) * scale);
        console.log(JSON.stringify({
          scenario, sample, phase: from.phase, ...delivery, wallMs: round(to.time - from.time),
          rendererMs: round((to.cpu.renderer - from.cpu.renderer) * 1000),
          gpuMs: round((to.cpu.gpu - from.cpu.gpu) * 1000),
          mainTaskMs: delta("TaskDuration", 1000), scriptMs: delta("ScriptDuration", 1000),
          layouts: delta("LayoutCount"), layoutMs: delta("LayoutDuration", 1000), styleRecalcs: delta("RecalcStyleCount"),
          paints: paints.length, paintMs: round(paints.reduce((sum, event) => sum + (event.tdur ?? event.dur ?? 0), 0) / 1000),
          rasterTasks: rendererEvents.filter((event) => event.name === "RasterTask" && event.ph === "X").length,
          paintsByNode
        }));
      }
    }
  }
});

benchmark("measures automatic pull paint and CPU", async ({ harness: { app, page } }) => {
  test.setTimeout(240_000);
  const cases = ["baseline", "static", "no-flex-transition", "no-detail", "no-invalidation", "steady", "steady-static"] as const;
  for (const trace of [false, true]) {
    // Interleave the A/B runs and alternate order to reduce warm-up bias.
    for (let sample = 0; sample < (trace ? 1 : 3); sample++) {
      for (const scenario of sample % 2 === 0 ? cases : [...cases].reverse()) {
        await page.reload();
        await ready(page);
        const steady = scenario === "steady" || scenario === "steady-static";
        const stationary = scenario === "static" || scenario === "steady-static";
        // The stationary cases use the shipped CSS. The other cases restore
        // the v0.61.2 animation on the face and vary at most one other input.
        await page.addStyleTag({ content: `
          ${stationary ? "" : `${inFlight}:not(.is-empty) { animation: bulk-sync-stripes 900ms linear infinite; }`}
          ${scenario === "no-flex-transition" ? `${toolbarBar} > i { transition: none; }` : ""}
        ` });
        if (steady) await start(page);
        await page.waitForTimeout(400);

        const cdp = await page.context().newCDPSession(page);
        const events: TraceEvent[] = [];
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        if (trace) {
          cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value as unknown as TraceEvent[]));
          await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,cc,viz" });
        }
        const beforeMetrics = await readMetrics(cdp);
        const beforeCpu = await readCpu(app);
        const wallStart = performance.now();
        const onset = trace || steady ? undefined : new Promise<void>((resolve) => setTimeout(resolve, 2000))
          .then(async () => ({ cpu: await readCpu(app), wallMs: performance.now() - wallStart }));
        await page.evaluate(() => performance.mark("bulk-sync-start"));
        let delivery: Awaited<ReturnType<typeof bulkSyncPaint.workload>> | undefined;
        if (steady) {
          await page.waitForTimeout(5_000);
        } else {
          await start(page);
          delivery = await page.evaluate((scenario) =>
            window.bulkSyncPaint.workload({
              detail: scenario !== "no-detail", invalidate: scenario !== "no-invalidation"
            }), scenario);
          await expect(page.locator(progressCount)).toHaveCount(0);
          // The pull receipt can finish ahead of the last targeted read.
          // Include the sidebar's commit and its next paint in the sample.
          await page.waitForFunction(() => window.bulkSyncPaint.refreshesCommitted);
          await page.evaluate(() => window.bulkSyncPaint.afterPaint());
          expect(delivery.completed).toBe(30);
          if (scenario === "no-invalidation") expect(delivery.targetedReads).toBe(0);
          else expect(delivery.targetedReads).toBeGreaterThan(0);
        }
        await page.evaluate(() => performance.mark("bulk-sync-end"));
        const wallMs = performance.now() - wallStart;
        const afterCpu = await readCpu(app);
        const onsetCpu = await onset;
        const afterMetrics = await readMetrics(cdp);
        expect(afterCpu.pid).toBe(beforeCpu.pid);
        if (trace) {
          const finished = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
          await cdp.send("Tracing.end");
          await finished;
        }
        await cdp.detach();
        const startTs = events.find((event) => event.name === "bulk-sync-start")?.ts;
        const endTs = events.find((event) => event.name === "bulk-sync-end")?.ts;
        if (trace) {
          expect(startTs).toBeDefined();
          expect(endTs).toBeGreaterThan(startTs!);
        }
        const paints = events.filter((event) => event.name === "Paint" && event.ph === "X" &&
          event.pid === beforeCpu.pid && event.ts >= startTs! && event.ts < endTs!);
        const round = (value: number) => +value.toFixed(2);
        const delta = (name: string, scale = 1) => round((afterMetrics[name]! - beforeMetrics[name]!) * scale);
        console.log(JSON.stringify({
          scenario, sample, trace, wallMs: round(wallMs), ...delivery,
          rendererMs: round((afterCpu.renderer - beforeCpu.renderer) * 1000),
          gpuMs: round((afterCpu.gpu - beforeCpu.gpu) * 1000),
          ...(onsetCpu === undefined ? {} : {
            onsetRendererPercent: round((onsetCpu.cpu.renderer - beforeCpu.renderer) * 100_000 / onsetCpu.wallMs)
          }),
          mainTaskMs: delta("TaskDuration", 1000), scriptMs: delta("ScriptDuration", 1000),
          layouts: delta("LayoutCount"), layoutMs: delta("LayoutDuration", 1000), styleRecalcs: delta("RecalcStyleCount"),
          ...(trace ? { paints: paints.length, paintMs: round(paints.reduce((us, paint) => us + (paint.dur ?? 0), 0) / 1000) } : {})
        }));
      }
    }
  }
});
