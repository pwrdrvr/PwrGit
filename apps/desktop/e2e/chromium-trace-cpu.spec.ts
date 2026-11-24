import { createPackage } from "@electron/asar";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { cleanEnv } from "./fixtures/electron-app";

const HERE = dirname(fileURLToPath(import.meta.url));

// The handoff uses a synthetic native export with many small Chromium events
// and nested, discarded arguments. Generate it outside the measurement window.
async function writeRawFixture(file: string, bytes: number) {
  const sample = (cat: string, name: string, pid: number) => ({
    cat, name, pid, tid: 43102, ph: "X", ts: 628212341234, dur: 42, tts: 721930201,
    args: { data: { frame: "synthetic-frame-id", url: "https://example.invalid/synthetic-argument",
      rect: [0, 0, 640, 480], description: "Synthetic Chromium trace argument" } }
  });
  const batch = ["cc", "cc", "cc", "viz", "devtools.timeline", "blink.user_timing", "disabled-by-default-fixture"]
    .map((cat, i) => JSON.stringify(sample(cat, i % 2 ? "Synthetic timing string" : "Layout", 12830 + i)))
    .join(",\n") + ",\n";
  const handle = await open(file, "w");
  try {
    await handle.write('{"traceEvents":[\n');
    const block = batch.repeat(256);
    const blocks = Math.floor(bytes / Buffer.byteLength(block));
    for (let i = 0; i < blocks; i++) await handle.write(block);
    await handle.write(JSON.stringify(sample("cc", "Paint", 12830)) + '],"metadata":{"fixture":true}}');
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

test("trace filtering cannot consume the main CPU trigger budget", async ({}, info) => {
  test.skip(process.env.PWRGIT_TRACE_CPU_BENCHMARK !== "1", "Opt-in pinned Electron CPU attribution benchmark");
  test.setTimeout(180_000);
  const html = info.outputPath("index.html");
  const bundle = info.outputPath("modules");
  const controller = join(bundle, "controller.mjs");
  const worker = join(bundle, "chromium-trace-worker.mjs");
  const fixture = info.outputPath("fixture.json");
  const archive = info.outputPath("app.asar");
  await mkdir(dirname(html), { recursive: true });
  await writeFile(html, "<main>Trace CPU fixture</main>");
  // The larger fixture reproduces the two-second trigger on a fast host.
  // Set 108942771 to measure an export close to the incident size.
  const rawBytes = await writeRawFixture(fixture, Number(process.env.PWRGIT_TRACE_CPU_FIXTURE_BYTES ?? 220_000_000));
  const entry = info.outputPath("entry.mts");
  await writeFile(entry, ["chromium-trace", "hot-cpu-profiler", "hot-cpu-profile-config",
    "main-process-hot-cpu-target", "app-metrics"].map(name =>
    `export * from ${JSON.stringify(join(HERE, "../src/main/diagnostics", name + ".ts"))};`).join("\n") +
    `\nexport { DIAGNOSTICS_DEFAULTS } from ${JSON.stringify(join(HERE, "../../../packages/shared/src/index.ts"))};\n`);
  await build({
    configFile: false, logLevel: "warn", ssr: { noExternal: true },
    build: { ssr: true, outDir: bundle, rollupOptions: {
      input: { controller: entry, "chromium-trace-worker": join(HERE, "../src/main/diagnostics/chromium-trace-worker.ts") },
      external: ["electron", "electron-log/main.js"], output: { entryFileNames: "[name].mjs" }
    } }
  });
  await createPackage(bundle, archive);

  const app = await electron.launch({
    args: [`--user-data-dir=${info.outputPath("profile")}`, "--disable-accelerated-video-decode", "--disable-accelerated-video-encode",
      join(HERE, "harness/electron-main.cjs")],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html })
  });
  try {
    const results = await app.evaluate(async ({ app }, args) => {
      await app.whenReady();
      const load = process.mainModule!.require.bind(process.mainModule);
      const fs = load("node:fs/promises") as typeof import("node:fs/promises");
      const { join } = load("node:path") as typeof import("node:path");
      const { Worker } = load("node:worker_threads") as typeof import("node:worker_threads");
      const { createHash } = load("node:crypto") as typeof import("node:crypto");
      const { createReadStream } = load("node:fs") as typeof import("node:fs");
      const { ChromiumTrace, HotCpuProfiler, resolveHotCpuProfileConfig, createMainProcessHotCpuTarget, readAppMetrics, DIAGNOSTICS_DEFAULTS } =
        load(args.controller) as typeof import("../src/main/diagnostics/chromium-trace") &
          typeof import("../src/main/diagnostics/hot-cpu-profiler") &
          typeof import("../src/main/diagnostics/hot-cpu-profile-config") &
          typeof import("../src/main/diagnostics/main-process-hot-cpu-target") &
          typeof import("../src/main/diagnostics/app-metrics") & typeof import("@pwrgit/shared");
      const config = resolveHotCpuProfileConfig({
        outputRoot: args.root, enabled: true, startDelayMs: 0, env: {},
        rules: { ...DIAGNOSTICS_DEFAULTS.hotCpuProfilingRules, high: { enabled: true, mode: "spike" } }
      });
      if (!config.enabled) throw new Error("Expected main profiler configuration");
      const profilerConfig = { ...config, profileDurationMs: 250, maxProfiles: 1 };
      app.setAppLogsPath(join(args.root, "logs"));
      const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
      const cpuMs = ({ user, system }: NodeJS.CpuUsage) => (user + system) / 1000;
      const workerSource = await fs.readFile(args.worker, "utf8");
      const commits = JSON.stringify(Array.from({ length: 4096 }, (_, i) => ({
        id: i.toString(16).padStart(40, "0"), subject: "Synthetic index update", paths: ["src/index.ts", "src/app.tsx"]
      })));
      function updateIndex() {
        const until = performance.now() + 29;
        do { JSON.parse(commits); } while (performance.now() < until);
      }
      async function scenario(mode: "none" | "thread" | "production", busy: boolean) {
        const label = `${mode}-${busy ? "busy" : "idle"}`;
        const output = join(args.root, label + ".trace.json");
        let workerCpuMs: number | undefined;
        const filterTrace = mode === "thread" ? async (rawPath: string, filteredPath: string) => {
          const source = `import { parentPort } from "node:worker_threads";\n${workerSource}\n
            parentPort.postMessage(process.threadCpuUsage());`;
          const worker = new Worker(new URL("data:text/javascript;base64," + Buffer.from(source).toString("base64")), {
            workerData: { rawPath, filteredPath, allowedCategories: ["devtools.timeline", "blink.user_timing", "cc", "viz"] },
            resourceLimits: { maxOldGenerationSizeMb: 96 }
          });
          worker.on("message", (usage: NodeJS.CpuUsage) => { workerCpuMs = cpuMs(usage); });
          await new Promise<void>((resolve, reject) => {
            worker.once("error", reject);
            worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
          });
        } : undefined;
        const trace = new ChromiumTrace(() => ({
          async startRecording() {},
          async stopRecording(file = "") { await fs.copyFile(args.fixture, file); return file; }
        }), () => {}, { workerModule: args.asarWorker, ...(filterTrace && { filterTrace }) });

        let resolveFirst!: () => void;
        let resolveSample!: () => void;
        const firstInterval = new Promise<void>(resolve => { resolveFirst = resolve; });
        const nextInterval = new Promise<void>(resolve => { resolveSample = resolve; });
        const samples: import("../src/main/diagnostics/hot-cpu-profile-session").HotCpuProfileSample[] = [];
        const captures: number[] = [];
        let mainBaseline = process.threadCpuUsage();
        let windowMainCpuMs = 0;
        let backgroundCpuAtSample: Promise<number> | undefined;
        let helperAtSample = false;
        const profiler = new HotCpuProfiler({
          config: profilerConfig,
          getAppMetrics: reuseForMs => {
            const read = readAppMetrics(reuseForMs);
            if (samples.length === 2) {
              helperAtSample = read.metrics.some(metric => metric.name === "PwrGit Chromium trace filter");
            }
            return read;
          },
          target: createMainProcessHotCpuTarget(),
          logger: { info() {}, warn() {}, error(error) { throw new Error(String(error)); } },
          session: {
            target: "main", id: label, directoryName: args.root, directoryPath: args.root,
            samplesPath: "", eventsPath: "", createProfilePath: () => join(args.root, label + ".cpuprofile"),
            createHeapSnapshotPath: () => "", async registerArtifact() {},
            async appendSample(sample) { samples.push(sample); }, async appendEvent() {}
          },
          onSampleCaptured: () => {
            if (samples.length === 2) { mainBaseline = process.threadCpuUsage(); resolveFirst(); }
            if (samples.length === 3) {
              windowMainCpuMs = cpuMs(process.threadCpuUsage(mainBaseline));
              backgroundCpuAtSample = background?.cpuUsage().then(cpuMs);
              resolveSample();
            }
          },
          onProfileTriggered: (_file, _when, time) => { captures.push(time); return undefined; }
        });
        let foreground: ReturnType<typeof setInterval> | undefined;
        let background: import("node:worker_threads").Worker | undefined;
        let traceResult: Awaited<ReturnType<typeof trace.capture>> | undefined;
        try {
          await trace.setArmed(true);
          await profiler.start();
          await firstInterval;
          if (busy) {
            foreground = setInterval(updateIndex, 38);
            background = new Worker(`
              const { createHash } = require("node:crypto");
              const input = Buffer.alloc(512 * 1024);
              setInterval(() => {
                const end = performance.now() + 4;
                do { createHash("sha256").update(input).digest(); } while (performance.now() < end);
              }, 30);
            `, { eval: true });
            // The first busy interval starts with application work. Start the
            // export late enough to cross the sampling boundary.
            await wait(1_675);
          }
          const began = performance.now();
          const mainStart = process.threadCpuUsage();
          const processStart = process.cpuUsage();
          traceResult = await trace.capture(output, performance.now(), () => mode !== "none");
          const measurement = {
            wallMs: performance.now() - began, mainMs: cpuMs(process.threadCpuUsage(mainStart)),
            browserMs: cpuMs(process.cpuUsage(processStart)), workerCpuMs, traceResult
          };
          await nextInterval;
          const sample = samples[2];
          const backgroundCpuMs = await backgroundCpuAtSample ?? 0;
          clearInterval(foreground);
          await profiler.stop();
          const profile = captures.length ? JSON.parse(await fs.readFile(join(args.root, label + ".cpuprofile"), "utf8")) : null;
          const hash = createHash("sha256");
          if (mode !== "none") {
            for await (const chunk of createReadStream(output)) hash.update(chunk);
          }
          return { label, ...measurement, windowMainCpuMs, backgroundCpuMs, sample, captures: captures.length,
            helperAtSample,
            profiledForeground: profile?.nodes.some((node: { callFrame: { functionName: string } }) =>
              node.callFrame.functionName === "updateIndex") ?? false,
            hash: mode === "none" ? null : hash.digest("hex") };
        } finally {
          clearInterval(foreground);
          await background?.terminate();
          await profiler.stop();
          await trace.setArmed(false);
        }
      }
      const scenarios = [];
      for (const busy of [false, true]) {
        for (const mode of ["none", "thread", "production"] as const) scenarios.push(await scenario(mode, busy));
      }
      return { electron: process.versions.electron, node: process.versions.node, scenarios };
    }, { controller, worker, fixture, asarWorker: join(archive, "chromium-trace-worker.mjs"), root: dirname(html) });

    console.log("Trace CPU oracle", { rawBytes, ...results, scenarios: results.scenarios.map(r => ({
      mode: r.label, wallMs: Math.round(r.wallMs), browserMs: Math.round(r.browserMs), workerCpuMs: r.workerCpuMs,
      mainMs: Math.round(r.mainMs), windowMainCpuMs: Math.round(r.windowMainCpuMs), backgroundCpuMs: Math.round(r.backgroundCpuMs),
      samplePercent: r.sample?.cpuPercent, captures: r.captures, profile: r.profiledForeground, helperAtSample: r.helperAtSample,
      filterCpuMs: r.traceResult?.status === "written" ? r.traceResult.filterCpuMs : undefined,
      filterElapsedMs: r.traceResult?.status === "written" ? r.traceResult.filterElapsedMs : undefined
    })) });
    const [idle, oldIdle, isolatedIdle, busy, oldBusy, isolatedBusy] = results.scenarios;
    expect(idle?.captures).toBe(0);
    expect(idle?.traceResult).toMatchObject({ status: "skipped", reason: "canceled" });
    if (rawBytes >= 200_000_000) expect(oldIdle?.captures).toBe(1);
    expect(isolatedIdle?.captures).toBe(0);
    expect(busy?.profiledForeground).toBe(true);
    expect(oldBusy?.profiledForeground).toBe(true);
    expect(isolatedBusy?.profiledForeground).toBe(true);
    expect(isolatedBusy?.helperAtSample).toBe(true);
    expect(isolatedIdle?.traceResult).toMatchObject({ status: "written", filterCpuMs: expect.any(Number) });
    expect(new Set([oldIdle?.hash, isolatedIdle?.hash, oldBusy?.hash, isolatedBusy?.hash]).size).toBe(1);
  } finally {
    await app.close();
  }
});
