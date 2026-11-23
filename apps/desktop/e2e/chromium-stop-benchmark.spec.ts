import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";

const HERE = dirname(fileURLToPath(import.meta.url));

test("measure native stops with the production 32 MiB ring", async ({}, info) => {
  test.skip(process.env.PWRGIT_TRACE_STOP_BENCHMARK !== "1", "Opt-in native trace timing benchmark");
  test.setTimeout(300_000);
  const html = info.outputPath("index.html");
  await mkdir(dirname(html), { recursive: true });
  await writeFile(html, `<!doctype html><main>${"<div class=row>Trace fixture</div>".repeat(160)}</main>
    <style>.row { contain: layout; background: linear-gradient(60deg,#def,#ab8); height: 16px }
    .layer { will-change: transform; animation: slide .31s infinite alternate linear }
    @keyframes slide { to { transform: translateX(48px) } }</style>`);
  const app = await electron.launch({
    args: [
      `--user-data-dir=${info.outputPath("profile")}`,
      "--disable-accelerated-video-decode", "--disable-accelerated-video-encode",
      join(HERE, "harness/electron-main.cjs")
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html })
  });
  try {
    await app.firstWindow();
    for (const mode of ["quiet", "full", "full-contended", "full-main-stall"] as const) {
      for (let run = 0; run < 3; run++) {
        const result = await app.evaluate(async ({ BrowserWindow, contentTracing }, { mode, file }) => {
          const load = process.mainModule!.require.bind(process.mainModule);
          const fs = load("node:fs/promises") as typeof import("node:fs/promises");
          const { Worker } = load("node:worker_threads") as typeof import("node:worker_threads");
          const contents = BrowserWindow.getAllWindows()[0]!.webContents;
          const execute = (script: string) => contents.executeJavaScript(script);
          const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
          const contended = mode === "full-contended" || mode === "full-main-stall";
          const competitors = contended ? Array.from({ length: 4 }, () => new Worker(`
            const { deflateSync } = require("node:zlib");
            const { randomFillSync } = require("node:crypto");
            const input = randomFillSync(Buffer.alloc(256 * 1024));
            setInterval(() => deflateSync(input), 8);
          `, { eval: true })) : [];
          let mainWork: ReturnType<typeof setInterval> | undefined;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          contents.debugger.attach("1.3");
          await contents.debugger.sendCommand("Profiler.enable");
          await contents.debugger.sendCommand("Profiler.start");
          try {
            await contentTracing.startRecording({
              record_mode: "record-continuously", trace_buffer_size_in_kb: 32 * 1024,
              included_categories: ["devtools.timeline", "blink.user_timing", "cc", "viz"],
              excluded_categories: ["*"]
            } as Electron.TraceConfig);
            await execute("performance.mark('early-overflow-marker'); undefined");
            if (mode !== "quiet") {
              await execute(`
                window.rows = [...document.querySelectorAll('.row')];
                for (const row of rows.slice(0, 40)) row.classList.add('layer');
                window.burst = function () {
                  for (let i = 0; i < 1200; i++) {
                    const row = rows[i % rows.length];
                    row.style.width = (300 + i % 64) + 'px';
                    row.getBoundingClientRect();
                    if (i % 100 === 0) performance.mark('synthetic-layout-' + i);
                  }
                  performance.clearMarks();
                };
                undefined
              `);
              for (let batch = 0; batch < 150; batch++) {
                await execute("burst()");
                await wait(12);
              }
            }
            await wait(750);
            await execute("performance.mark('lead-in-marker'); undefined");
            const { percentage } = await contentTracing.getTraceBufferUsage();
            const commits = JSON.stringify(Array.from({ length: 4096 }, (_, i) => ({
              id: i.toString(16).padStart(40, "0"),
              subject: "Synthetic index update",
              paths: ["src/index.ts", "src/app.tsx"]
            })));
            const parseBatches = (durationMs: number) => {
              const until = performance.now() + durationMs;
              do { JSON.parse(commits); } while (performance.now() < until);
            };
            if (mode === "full-contended") mainWork = setInterval(() => parseBatches(38), 40);
            const requestedAt = performance.now();
            const nativeStop = contentTracing.stopRecording(file);
            if (mode === "full-main-stall") setImmediate(() => parseBatches(4_500));
            const stopMs = await Promise.race([
              nativeStop.then(() => performance.now() - requestedAt),
              new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(() => reject(new Error("Native stop exceeded the benchmark ceiling")), 28_000);
              })
            ]);
            clearInterval(mainWork);
            const raw = await fs.readFile(file, "utf8");
            const { traceEvents } = JSON.parse(raw) as { traceEvents: { name: string; cat: string }[] };
            return {
              mode, electron: process.versions.electron, chrome: process.versions.chrome,
              percentage, stopMs: Math.round(stopMs), rawBytes: Buffer.byteLength(raw),
              earlyMarker: traceEvents.some(({ name }) => name === "early-overflow-marker"),
              leadInMarker: traceEvents.some(({ name }) => name === "lead-in-marker"),
              layouts: traceEvents.filter(({ name }) => name === "Layout").length,
              compositor: traceEvents.filter(({ cat }) => cat === "cc" || cat === "viz").length
            };
          } finally {
            clearInterval(mainWork);
            clearTimeout(deadline);
            await fs.rm(file, { force: true });
            await Promise.all(competitors.map((worker) => worker.terminate()));
            await contents.debugger.sendCommand("Profiler.stop");
            contents.debugger.detach();
            await execute("document.querySelectorAll('.layer').forEach((row) => row.classList.remove('layer'))");
          }
        }, { mode, file: info.outputPath(`native-${run}.json`) });
        console.log("Native Chromium stop", { run, ...result });
        expect(result.leadInMarker).toBe(true);
        if (mode !== "quiet") {
          expect(result.percentage).toBeGreaterThan(0.99);
          expect(result.earlyMarker).toBe(false);
          expect(result.layouts).toBeGreaterThan(0);
          expect(result.compositor).toBeGreaterThan(0);
        }
      }
    }
  } finally {
    await app.close();
  }
});
