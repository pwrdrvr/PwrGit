import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { bulkSyncPaint } from "./harness/bulk-sync-paint/main";

declare global {
  interface Window {
    bulkSyncPaint: typeof bulkSyncPaint;
  }
}

const test = base.extend<{ harness: { app: ElectronApplication; page: Page } }>({
  harness: async ({}, use) => {
    const out = mkdtempSync(join(tmpdir(), "pwrgit-bulk-sync-paint-"));
    try {
      const html = await buildHarness("bulk-sync-paint", join(out, "dist"));
      const app = await electron.launch({
        args: [
          "--disable-accelerated-video-decode",
          "--disable-accelerated-video-encode",
          ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
          fileURLToPath(new URL("./harness/electron-main.cjs", import.meta.url))
        ],
        env: cleanEnv({
          PWRGIT_HARNESS_HTML: html, PWRGIT_HARNESS_WIDTH: "320", PWRGIT_HARNESS_HEIGHT: "680"
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

const toolbarBar = ".sidebar-toolbar__progress";
const inFlight = `${toolbarBar} > .is-in-flight`;
const progressCount = ".sidebar-toolbar__count";

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => "bulkSyncPaint" in window);
  await page.evaluate(() => window.bulkSyncPaint.ready);
  await expect(page.getByRole("button", { name: "Try pull all" })).toBeEnabled();
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

type TraceEvent = { name: string; pid: number; ts: number; dur?: number; ph: string };

const benchmark = process.env["PWRGIT_BULK_PAINT_BENCH"] === "1" ? test : test.skip;
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
        const cpu = () => app.evaluate(({ app, BrowserWindow }) => {
          const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
          const metrics = app.getAppMetrics();
          const renderer = metrics.find((metric) => metric.pid === pid)?.cpu.cumulativeCPUUsage;
          if (renderer === undefined) throw new Error("No renderer CPU counter");
          return {
            pid,
            renderer,
            gpu: metrics.find((metric) => metric.type === "GPU")?.cpu.cumulativeCPUUsage ?? 0
          };
        });
        const metrics = async () => Object.fromEntries(
          (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])
        );
        const beforeMetrics = await metrics();
        const beforeCpu = await cpu();
        const wallStart = performance.now();
        const onset = trace || steady ? undefined : new Promise<void>((resolve) => setTimeout(resolve, 2000))
          .then(async () => ({ cpu: await cpu(), wallMs: performance.now() - wallStart }));
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
          expect(delivery.completed).toBe(30);
          if (scenario === "no-invalidation") expect(delivery.targetedReads).toBe(0);
          else expect(delivery.targetedReads).toBeGreaterThan(0);
        }
        await page.evaluate(() => performance.mark("bulk-sync-end"));
        const wallMs = performance.now() - wallStart;
        const afterCpu = await cpu();
        const onsetCpu = await onset;
        const afterMetrics = await metrics();
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
