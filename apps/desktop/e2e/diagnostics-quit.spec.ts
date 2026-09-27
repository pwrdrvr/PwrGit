import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";

let handle: AppHandle | undefined;
let outputRoot: string;

test.beforeEach(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "pwrgit-e2e-quit-"));
  const overrides = {
    PWRGIT_STARTUP_CPU_PROFILING: "1",
    PWRGIT_STARTUP_CPU_PROFILING_DIR: outputRoot,
    PWRGIT_STARTUP_CPU_PROFILING_POST_LOAD_MS: "60000",
    PWRGIT_STARTUP_CPU_PROFILING_HARD_TIMEOUT_MS: "60000",
    PWRGIT_STARTUP_CPU_PROFILING_HEAP_SNAPSHOTS: "0",
    PWRGIT_STARTUP_CPU_PROFILING_QUIT_ON_COMPLETE: "0"
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    handle = await launchApp({ agentUnavailable: true });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test.afterEach(async () => {
  await handle?.cleanup();
  handle = undefined;
  await rm(outputRoot, { recursive: true, force: true });
});

async function activeSession(): Promise<string> {
  const [directory] = await readdir(outputRoot);
  const session = join(outputRoot, directory!);
  await expect.poll(async () => {
    const events = (await readFile(join(session, "events.ndjson"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    return events.filter((event) => event.type === "profiler-started")
      .map((event) => event.source).sort();
  }).toEqual(["main", "renderer"]);
  return session;
}

test("quit saves active main and renderer captures before destroying their targets", async () => {
  const session = await activeSession();
  const closed = handle!.app.waitForEvent("close");
  const started = Date.now();
  await handle!.app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  await closed;
  const elapsed = Date.now() - started;
  console.log(`diagnostics quit completed in ${elapsed} ms`);
  expect(elapsed).toBeLessThan(10_000);
  for (const source of ["main", "renderer"]) {
    const profile = JSON.parse(await readFile(join(session, `${source}.cpuprofile`), "utf8"));
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(profile.endTime).toBeGreaterThan(profile.startTime);
  }
  const manifest = JSON.parse(await readFile(join(session, "session.json"), "utf8"));
  expect(manifest.status).toBe("completed");
  expect(manifest.completedAt).toEqual(expect.any(String));
});

test("a hung inspector stop and repeated quits still exit after the shared deadline", async () => {
  await activeSession();
  const closed = handle!.app.waitForEvent("close");
  const started = Date.now();
  await handle!.app.evaluate(({ app, BrowserWindow }) => {
    // Leave the event loop responsive, but never answer this capture's stop.
    for (const window of BrowserWindow.getAllWindows()) {
      const debuggerTarget = window.webContents.debugger;
      const send = debuggerTarget.sendCommand.bind(debuggerTarget);
      debuggerTarget.sendCommand = (method, ...args) => method === "Profiler.stop"
        ? new Promise(() => {})
        : send(method, ...args);
    }
    setImmediate(() => app.quit());
    setInterval(() => app.quit(), 100);
  });
  await closed;
  const elapsed = Date.now() - started;
  console.log(`hung diagnostics quit completed in ${elapsed} ms`);
  expect(elapsed).toBeGreaterThanOrEqual(10_000);
  expect(elapsed).toBeLessThan(15_000);
});
