import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import ts from "typescript";
import { cleanEnv } from "./fixtures/electron-app";

const HERE = dirname(fileURLToPath(import.meta.url));

test("rolling Chromium trace retains recent events after overflow and publishes only safe fields", async ({}, info) => {
  test.setTimeout(90_000);
  const html = info.outputPath("index.html");
  const controller = info.outputPath("chromium-trace.mjs");
  const worker = info.outputPath("chromium-trace-worker.mjs");
  const artifact = info.outputPath("renderer.trace.json");
  await mkdir(dirname(html), { recursive: true });
  await writeFile(html, "<!doctype html><meta charset=utf-8><main>Trace fixture</main>");
  for (const [name, destination] of [["chromium-trace", controller], ["chromium-trace-worker", worker]] as const) {
    const source = await readFile(join(HERE, `../src/main/diagnostics/${name}.ts`), "utf8");
    await writeFile(destination, ts.transpile(source, {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext
    }));
  }

  const privateValue = "synthetic-private-trace-value";
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
    const result = await app.evaluate(async ({ BrowserWindow, contentTracing }, args) => {
      const load = process.mainModule!.require.bind(process.mainModule);
      const { ChromiumTrace } = load(args.controller) as typeof import("../src/main/diagnostics/chromium-trace");
      const fs = load("node:fs/promises") as typeof import("node:fs/promises");
      const win = BrowserWindow.getAllWindows()[0]!;
      const warnings: string[] = [];
      let raw = "";
      const trace = new ChromiumTrace(() => ({
        startRecording: (config) => contentTracing.startRecording(config),
        async stopRecording(file) {
          const written = await contentTracing.stopRecording(file);
          // Inspect the native recording in memory before the production
          // publisher removes it. The fixture contains only synthetic data.
          raw = await fs.readFile(written, "utf8");
          return written;
        }
      }), (message, error) => warnings.push(`${message}: ${String(error)}`), { bufferSizeKb: 1024, workerModule: args.worker });

      await trace.setArmed(true);
      await win.webContents.executeJavaScript("performance.mark('early-overflow-marker')");
      for (let batch = 0; batch < 24; batch++) {
        await win.webContents.executeJavaScript(`
          for (let i = 0; i < 1200; i++) {
            performance.mark('flood-${batch}-' + i + '-' + 'x'.repeat(180));
          }
          performance.clearMarks();
        `);
        // Let the producer drain between bursts rather than dropping all the
        // events in its shared-memory pipe before they reach the ring.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Regenerate Perfetto's interned state after evicting its earlier
      // dictionary packets. Chromium clears that state every 500 ms.
      await new Promise((resolve) => setTimeout(resolve, 750));
      const trigger = performance.now();
      await win.webContents.executeJavaScript(`
        (async () => {
          performance.mark('recent-overflow-marker');
          performance.mark(${JSON.stringify(args.privateValue)});
          await fetch(${JSON.stringify(args.url)}).then((response) => response.text());
          document.body.style.width = '513px';
          document.body.getBoundingClientRect();
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const capture = await trace.capture(args.artifact, trigger);
      const events: { name?: string }[] = JSON.parse(raw).traceEvents;
      return {
        warnings, capture,
        early: events.some((event) => event.name === "early-overflow-marker"),
        recent: events.some((event) => event.name === "recent-overflow-marker"),
        hadPrivateUrl: raw.includes(args.url)
      };
    }, { controller, worker, artifact, privateValue, url });

    expect(result.warnings).toEqual([]);
    expect(result.capture.status).toBe("written");
    expect(result.recent, "recent marker must survive buffer overflow").toBe(true);
    expect(result.early, "old marker must be evicted from the rolling buffer").toBe(false);
    expect(result.hadPrivateUrl, "the native trace must contain the synthetic URL").toBe(true);
    const saved = await readFile(artifact, "utf8");
    expect(saved).not.toContain(privateValue);
    expect(saved).not.toContain(url);
    expect(JSON.parse(saved).traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Layout", ts: expect.any(Number) }),
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
