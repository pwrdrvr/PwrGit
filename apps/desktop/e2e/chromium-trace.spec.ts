import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { DIAGNOSTICS_DEFAULTS } from "@pwrgit/shared";
import { build } from "vite";
import { cleanEnv } from "./fixtures/electron-app";

const HERE = dirname(fileURLToPath(import.meta.url));

test("rolling Chromium trace retains renderer trigger context under repaint pressure", async ({}, info) => {
  test.setTimeout(90_000);
  const html = info.outputPath("index.html");
  const controller = info.outputPath("diagnostics-manager.mjs");
  const worker = info.outputPath("chromium-trace-worker.mjs");
  const outputRoot = info.outputPath("diagnostics");
  await mkdir(dirname(html), { recursive: true });
  await writeFile(html, "<!doctype html><meta charset=utf-8><main>Trace fixture</main>");
  await build({
    configFile: false,
    logLevel: "warn",
    ssr: { noExternal: true },
    build: {
      ssr: true,
      outDir: dirname(worker),
      emptyOutDir: false,
      rollupOptions: {
        input: {
          "diagnostics-manager": join(HERE, "../src/main/diagnostics/diagnostics-manager.ts"),
          "chromium-trace-worker": join(HERE, "../src/main/diagnostics/chromium-trace-worker.ts")
        },
        external: ["electron", "electron-log/main.js"],
        output: { entryFileNames: "[name].mjs" }
      }
    }
  });

  const privateValue = "synthetic-private-trace-value";
  const lineageMark = "PwrGit Lineage publish repo-change view=1 target=2";
  const server = createServer((_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end("synthetic fixture");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server address");
    const url = `http://127.0.0.1:${address.port}/trace-resource?token=${privateValue}`;
    app = await electron.launch({
      args: [
        `--user-data-dir=${info.outputPath("profile")}`,
        "--disable-accelerated-video-decode",
        "--disable-accelerated-video-encode",
        join(HERE, "harness/electron-main.cjs")
      ],
      env: cleanEnv({ PWRGIT_HARNESS_HTML: html })
    });
    const page = await app.firstWindow();
    await expect(page.locator("main")).toHaveText("Trace fixture");
    const profileDurationMs = 6_000;
    const result = await app.evaluate(async ({ app, BrowserWindow, contentTracing }, args) => {
      app.setAppLogsPath(args.logsPath);
      const load = process.mainModule!.require.bind(process.mainModule);
      const { DiagnosticsManager } = load(args.controller) as typeof import("../src/main/diagnostics/diagnostics-manager");
      const fs = load("node:fs/promises") as typeof import("node:fs/promises");
      const { join } = load("node:path") as typeof import("node:path");
      const win = BrowserWindow.getAllWindows()[0]!;
      const pid = win.webContents.getOSProcessId();
      const execute = (script: string) => win.webContents.executeJavaScript(script);
      let cpu = 0;
      app.getAppMetrics = () => [{
        pid, type: "Tab", cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 1, peakWorkingSetSize: 1 }, creationTime: 1, name: "renderer", serviceName: ""
      }];
      process.env.PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS = "50";
      process.env.PWRGIT_HOT_CPU_PROFILING_DURATION_MS = String(args.profileDurationMs);
      process.env.PWRGIT_HOT_CPU_PROFILING_MAX_PROFILES = "1";
      const startRecording = contentTracing.startRecording.bind(contentTracing);
      const stopRecording = contentTracing.stopRecording.bind(contentTracing);
      // Use a smaller native ring so real renderer activity forces eviction on
      // fast and slow CI hosts without needing a full 32 MiB of Perfetto data.
      contentTracing.startRecording = (config) => startRecording({ ...config, trace_buffer_size_in_kb: 1024 });
      let raw = "";
      contentTracing.stopRecording = async (file) => {
        const written = await stopRecording(file);
        // In-memory oracle from the native export, with synthetic data only.
        raw = await fs.readFile(written, "utf8");
        return written;
      };
      let onHotCpuProfileCaptured!: (event: import("@pwrgit/shared").HotCpuProfileCapturedEvent) => void;
      const profileWritten = new Promise<import("@pwrgit/shared").HotCpuProfileCapturedEvent>((resolve) => {
        onHotCpuProfileCaptured = resolve;
      });
      const manager = new DiagnosticsManager({
        outputRoot: args.outputRoot, chromiumTraceWorker: args.worker,
        getDiagnostics: () => args.settings, onHotCpuProfileCaptured,
        onHotCpuHeapSnapshotLimitReached: () => {}
      });
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      async function repaintBurst(phase: "leadIn" | "postTrigger") {
        for (let batch = 0; batch < 24; batch++) {
          await execute(`
            (function ${phase}Repaint() {
              const rows = document.querySelector('main').children;
              for (let i = 0; i < 1200; i++) {
                const row = rows[i % rows.length];
                row.style.width = (300 + i % 64) + 'px';
                row.getBoundingClientRect();
                performance.mark('${phase}-${batch}-' + i + '-' + 'x'.repeat(180));
              }
              performance.clearMarks();
            })()
          `);
          // Allow the producer to drain each burst into the rolling ring.
          await wait(25);
        }
      }

      try {
        await execute(`document.querySelector('main').insertAdjacentHTML('beforeend', '<div>Row</div>'.repeat(120))`);
        manager.attachWindow(win);
        await manager.sync();
        await execute("performance.mark('early-overflow-marker')");
        await repaintBurst("leadIn");
        // Let Perfetto regenerate interned state after evicting old packets.
        await wait(750);
        await execute(`
          performance.mark('lead-in-marker');
          document.body.style.width = '511px';
          document.body.getBoundingClientRect();
        `);
        await wait(200);
        await execute(`
          (async () => {
            performance.mark('trigger-window-marker');
            performance.mark(${JSON.stringify(args.lineageMark)});
            performance.clearMarks(${JSON.stringify(args.lineageMark)});
            performance.mark(${JSON.stringify(args.privateValue)});
            await fetch(${JSON.stringify(args.url)}).then((response) => response.text());
            document.body.style.width = '513px';
            document.body.getBoundingClientRect();
          })()
        `);
        cpu = 90;
        const sessions = await Promise.all((await fs.readdir(args.outputRoot)).map(async (name) => {
          const directory = join(args.outputRoot, name);
          const manifest = JSON.parse(await fs.readFile(join(directory, "session.json"), "utf8"));
          return { directory, target: manifest.target };
        }));
        const renderer = sessions.find(({ target }) => target === "renderer");
        if (!renderer) throw new Error("Missing renderer diagnostics session");
        const eventsPath = join(renderer.directory, "events.ndjson");
        const readEvents = async () => (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        let started;
        for (let attempt = 0; attempt < 100 && !started; attempt++) {
          started = (await readEvents()).find((event) => event.type === "profile-started");
          if (!started) await wait(20);
        }
        if (!started) throw new Error("Renderer CPU sampler did not trigger");
        await repaintBurst("postTrigger");
        await wait(750);
        await execute("performance.mark('late-overflow-marker')");
        const profile = await profileWritten;
        const cpuProfile = JSON.parse(await fs.readFile(profile.profilePath, "utf8"));
        const triggerUs = cpuProfile.startTime + started.detail.preTriggerDurationMs * 1000;
        const events: { name: string; pid: number; tid: number; ts: number; args?: { name?: string } }[] = JSON.parse(raw).traceEvents;
        const mainThread = events.find((event) => event.pid === pid && event.name === "thread_name" && event.args?.name === "CrRendererMain");
        const markerMs = (name: string) => {
          const marker = events.find((event) => event.pid === pid && event.name === name);
          return marker ? (marker.ts - triggerUs) / 1000 : null;
        };
        const capture = (await readEvents()).find((event) => event.type === "chromium-trace-written");
        return {
          capture: capture?.detail,
          artifact: join(profile.sessionDirectory, capture?.detail.filename ?? "missing"),
          pid, tid: mainThread?.tid, triggerUs,
          leadInMs: markerMs("lead-in-marker"), triggerMarkerMs: markerMs("trigger-window-marker"),
          early: events.some((event) => event.name === "early-overflow-marker"),
          late: events.some((event) => event.name === "late-overflow-marker"),
          hadPrivateUrl: raw.includes(args.url),
          profilePostTriggerMs: (cpuProfile.endTime - triggerUs) / 1000,
          profiledRepaint: cpuProfile.nodes.some((node: { callFrame: { functionName: string } }) => node.callFrame.functionName === "postTriggerRepaint")
        };
      } finally {
        await manager.shutdown();
      }
    }, { controller, worker, outputRoot, privateValue, lineageMark, url, profileDurationMs, logsPath: info.outputPath("logs"), settings: {
      ...DIAGNOSTICS_DEFAULTS, hotCpuProfilingEnabled: true, hotCpuProfilingStartDelayMs: 0 as const,
      hotCpuProfilingTriggerMode: "spike" as const, hotCpuProfilingCaptureChromiumTrace: true
    } });

    expect(result.capture).toMatchObject({ status: "written" });
    const saved = await readFile(result.artifact, "utf8");
    expect(saved).toContain(JSON.stringify(lineageMark));
    const triggerEvents: { pid: number; tid: number; ts: number; name: string }[] = JSON.parse(saved).traceEvents.filter(
      (event: { pid: number; tid: number; ts: number }) =>
        event.pid === result.pid && event.tid === result.tid && Math.abs(event.ts - result.triggerUs) < 500_000
    );
    console.log("Chromium trace oracle", {
      rawBytes: result.capture.rawBytes,
      nativeStopAfterTriggerMs: result.capture.recordingStoppedAtMs - result.capture.triggerAtMs,
      leadInMs: result.leadInMs, triggerMarkerMs: result.triggerMarkerMs, lateMarker: result.late,
      layoutsInTriggerWindow: triggerEvents.filter(({ name }) => name === "Layout").length,
      profilePostTriggerMs: result.profilePostTriggerMs
    });
    expect(result.early, "old marker must be evicted from the rolling buffer").toBe(false);
    expect(result.triggerMarkerMs, "renderer work at detection must survive post-trigger pressure").not.toBeNull();
    expect(Math.abs(result.triggerMarkerMs!)).toBeLessThan(500);
    expect(result.leadInMs, "the same trace must retain renderer work before detection").not.toBeNull();
    expect(result.leadInMs!).toBeLessThan(result.triggerMarkerMs!);
    expect(result.late, "follow-up repaint work must happen after the native trace freezes").toBe(false);
    expect(result.profilePostTriggerMs).toBeGreaterThanOrEqual(profileDurationMs - 100);
    expect(result.profiledRepaint).toBe(true);
    expect(result.hadPrivateUrl, "the native trace must contain the synthetic URL").toBe(true);
    expect(saved).not.toContain(privateValue);
    expect(saved).not.toContain(url);
    const markerUs = result.triggerUs + result.triggerMarkerMs! * 1000;
    expect(triggerEvents.some((event) => event.name === "Layout" && event.ts < markerUs)).toBe(true);
    expect(triggerEvents.filter((event) => event.ts >= markerUs)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Layout", dur: expect.any(Number) }),
      expect.objectContaining({ name: "ResourceSendRequest" })
    ]));
  } finally {
    try {
      await app?.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
