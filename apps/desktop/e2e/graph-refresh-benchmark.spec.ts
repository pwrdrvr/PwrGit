import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { cleanEnv } from "./fixtures/electron-app";
import type {} from "./harness/graph-refresh/main";

// Opt-in because this reloads a large synthetic graph for every sample.
const benchmark = process.env.PWRGIT_GRAPH_REFRESH_BENCH === "1" ? test : test.skip;

const target = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
for (const dev of [true, false]) {
  benchmark(`lineage refresh ${dev ? "dev" : "production"}`, async () => {
    test.setTimeout(160_000);
    const out = mkdtempSync(join(tmpdir(), "pwrgit-graph-refresh-"));
    const html = join(out, "dist", "index.html");
    try {
      const env = dev ? "development" : "production";
      process.env.NODE_ENV = env;
      await build({
        configFile: false, root: target("./harness/graph-refresh"), base: "./",
        mode: env, logLevel: "warn", plugins: [react()],
        build: { outDir: join(out, "dist"), minify: !dev, emptyOutDir: true },
      });
      const scripts = join(out, "dist", "assets");
      const client = readdirSync(scripts).filter(name => name.endsWith(".js"))
        .map(name => readFileSync(join(scripts, name), "utf8")).join("");
      expect(client.includes("function logComponentRender")).toBe(dev);
      const app = await electron.launch({
        args: [
          `--user-data-dir=${join(out, "user")}`,
          target("./harness/electron-main.cjs")
        ],
        env: cleanEnv({ PWRGIT_HARNESS_HTML: html })
      });
      try {
        const page = await app.firstWindow();
        page.on("pageerror", error => console.warn(error.message));
        await page.emulateMedia({ reducedMotion: "reduce" });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        const taskDuration = async () => (await cdp.send("Performance.getMetrics")).metrics.find(m => m.name === "TaskDuration")!.value * 1000;
        const cpu = async () => app.evaluate(({ app, BrowserWindow }) => {
          const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
          return app.getAppMetrics().find(metric => metric.pid === pid)!.cpu.cumulativeCPUUsage * 1000;
        });
        for (const sample of [0, 1, 2, 3, 4, 5]) {
          for (const timing of (dev ? (sample % 2 === 0 ? [true, false] : [false, true]) : [true])) {
            for (const kind of (sample % 2 === 0 ? ["equal", "refs", "new-commit"] : ["new-commit", "refs", "equal"]) as ("equal" | "refs" | "new-commit")[]) {
              await page.goto(pathToFileURL(html).toString() + (timing ? "" : "?no-timing"));
              await page.evaluate(() => window.graphBench.ready());
              await page.waitForTimeout(125);
              const beforeCpu = await cpu();
              const beforeTask = await taskDuration();
              const data = await page.evaluate(kind => window.graphBench.refresh(kind), kind);
              const taskMs = await taskDuration() - beforeTask;
              const cpuMs = await cpu() - beforeCpu;
              expect(data.rows).toBe(kind === "new-commit" ? 1001 : 1000);
              expect(data.timingEnabled).toBe(timing);
              console.log(JSON.stringify({ dev, timing, sample, kind, cpuMs, taskMs, ...data }));
            }
          }
        }
      } finally {
        await app.close();
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}
