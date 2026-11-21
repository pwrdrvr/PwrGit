import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { StartupCpuProfileCapturedEvent } from "@pwrgit/shared";
import { startStartupCpuProfiling } from "./diagnostics-manager";
import { MainProcessCpuProfiler } from "./main-process-cpu-profiler";
import { StartupCpuProfileNotice } from "./startup-cpu-notice";

vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0-test", quit: vi.fn() } }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
// A real heap snapshot of the test runner is hundreds of MB; the artifact
// list only needs the file to exist.
vi.mock("node:v8", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:v8")>(),
  writeHeapSnapshot: vi.fn((path: string) => { writeFileSync(path, "{}\n"); return path; })
}));

type Renderer = "none" | "ok" | "stop-fails";

function window(mode: Renderer): BrowserWindow {
  let attached = false;
  const debuggerTarget = {
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    isAttached: () => attached,
    on: () => {},
    off: () => {},
    sendCommand: async (method: string) => {
      if (method !== "Profiler.stop") return {};
      if (mode === "stop-fails") throw new Error("Target closed");
      return { profile: { nodes: [{ id: 1 }], startTime: 1, endTime: 2, samples: [1], timeDeltas: [1] } };
    }
  };
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerTarget,
    isDestroyed: () => false,
    takeHeapSnapshot: async (path: string) => { writeFileSync(path, "{}\n"); }
  });
  return { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reports each finished startup capture once, listing exactly the files it left on disk", async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(),
    fc.constantFrom<Renderer>("none", "ok", "stop-fails"),
    fc.boolean(),
    async (mainStarts, renderer, heapSnapshots) => {
      const root = await mkdtemp(join(tmpdir(), "pwrgit-startup-notice-"));
      vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_DIR", root);
      vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_POST_LOAD_MS", "1");
      vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_HARD_TIMEOUT_MS", renderer === "none" ? "20" : "15000");
      vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_HEAP_SNAPSHOTS", heapSnapshots ? "1" : "0");
      if (!mainStarts) vi.spyOn(MainProcessCpuProfiler.prototype, "start").mockResolvedValue(false);
      const events: StartupCpuProfileCapturedEvent[] = [];
      let done!: () => void;
      const completed = new Promise<void>((resolve) => { done = resolve; });
      try {
        const startup = await startStartupCpuProfiling({
          enabled: true,
          outputRoot: root,
          onCompleted: (event) => { events.push(event); done(); }
        });
        expect(startup).not.toBeNull();
        if (renderer !== "none") {
          const first = window(renderer);
          startup!.attachFirstWindow(first);
          first.webContents.emit("did-finish-load");
        }
        await completed;
        await startup!.stop(); // Joins completion; must not report again.
        expect(events).toHaveLength(1);
        const event = events[0]!;

        // Oracle: the session directory itself.
        const [directoryName] = await readdir(root);
        const directory = join(root, directoryName!);
        expect(event.sessionDirectory).toBe(directory);
        expect(event.sessionDirectoryName).toBe(directoryName);
        const onDisk = (await readdir(directory)).sort();
        const nonEmpty = [];
        for (const name of onDisk) if ((await stat(join(directory, name))).size > 0) nonEmpty.push(name);
        expect(event.artifacts.map((artifact) => artifact.filename).sort()).toEqual(nonEmpty);
        for (const artifact of event.artifacts) expect(artifact.path).toBe(join(directory, artifact.filename));

        const mainSaved = onDisk.includes("main.cpuprofile");
        const rendererSaved = onDisk.includes("renderer.cpuprofile");
        expect(mainSaved).toBe(mainStarts);
        expect(rendererSaved).toBe(renderer === "ok");
        expect(event.missing).toEqual([
          ...(mainSaved ? [] : ["main-profile"]),
          ...(rendererSaved ? [] : ["renderer-profile"])
        ]);
        const manifest = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
        expect(event.status).toBe(manifest.status);
        expect(event.status).toBe(mainSaved && rendererSaved ? "completed" : mainSaved || rendererSaved ? "partial" : "failed");
        expect(event.armedBy).toBe("settings");
        expect(event.reason).toBe(renderer === "none" ? "hard-timeout" : "post-load-elapsed");
      } finally {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    }
  ), { numRuns: 24 });
}, 60_000);

it("keeps the capture for windows that mount later, until a dismissal of that session", () => {
  const emitted: Array<[string, unknown]> = [];
  const notice = new StartupCpuProfileNotice({
    captured: (payload) => { emitted.push(["diagnostics:startupCpuProfileCaptured", payload]); },
    dismissed: (sessionId) => { emitted.push(["diagnostics:startupCpuProfileDismissed", { sessionId }]); }
  });
  const event = { sessionId: "a1b2c3" } as StartupCpuProfileCapturedEvent;
  expect(notice.read()).toBeNull();
  notice.publish(event);
  expect(emitted).toEqual([["diagnostics:startupCpuProfileCaptured", event]]);
  expect(notice.read()).toBe(event); // A window mounting now still gets it.
  expect(notice.read()).toBe(event); // Reading does not consume it.
  notice.dismiss("other-session");
  expect(notice.read()).toBe(event);
  notice.dismiss("a1b2c3");
  expect(notice.read()).toBeNull();
  expect(emitted.at(-1)).toEqual(["diagnostics:startupCpuProfileDismissed", { sessionId: "a1b2c3" }]);
});
