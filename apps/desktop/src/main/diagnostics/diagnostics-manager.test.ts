import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { app, type BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_DEFAULTS } from "@pwrgit/shared";
import {
  DiagnosticsManager,
  startStartupCpuProfiling,
  type StartupCpuDiagnostics
} from "./diagnostics-manager";
import { MainProcessCpuProfiler } from "./main-process-cpu-profiler";
import { RendererStartupCpuProfiler } from "./renderer-startup-cpu-profiler";

vi.mock("electron", () => ({ app: { getVersion: () => "1.0.0", quit: vi.fn() } }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("node:v8", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:v8")>(),
  writeHeapSnapshot: vi.fn(() => { throw new Error("must not start a heap snapshot on quit"); })
}));

describe("startup capture shutdown", () => {
  let root: string;
  let diagnostics: StartupCpuDiagnostics | null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pwrgit-quit-profile-"));
    diagnostics = null;
    vi.mocked(app.quit).mockClear();
    vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_DIR", root);
    vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_HEAP_SNAPSHOTS", "0");
    vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_QUIT_ON_COMPLETE", "0");
    vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_HARD_TIMEOUT_MS", "15000");
  });

  afterEach(async () => {
    await diagnostics?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("saves a real inspector profile and final manifest when quit interrupts startup", async () => {
    vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_HEAP_SNAPSHOTS", "1");
    diagnostics = await startStartupCpuProfiling({ enabled: true, outputRoot: root });
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.isRecording()).toBe(true);
    const stopping = diagnostics!.stop();
    expect(diagnostics!.stop()).toBe(stopping);
    expect(diagnostics!.isRecording()).toBe(true);
    await stopping;
    expect(diagnostics!.isRecording()).toBe(false);

    const [directory] = await readdir(root);
    const profile = JSON.parse(await readFile(join(root, directory!, "main.cpuprofile"), "utf8"));
    const manifest = JSON.parse(await readFile(join(root, directory!, "session.json"), "utf8"));
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(profile.endTime).toBeGreaterThan(profile.startTime);
    expect(manifest.status).toBe("partial"); // No renderer was attached.
    expect(manifest.mainProfile.capturedAt).toEqual(expect.any(String));
    expect(manifest.completedAt).toEqual(expect.any(String));
    expect(writeHeapSnapshot).not.toHaveBeenCalled();
  });

  it("joins completion already started by the capture timer", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalStop = MainProcessCpuProfiler.prototype.stop;
    const stop = vi.spyOn(MainProcessCpuProfiler.prototype, "stop").mockImplementation(async function (this: MainProcessCpuProfiler, reason) {
      await gate;
      return originalStop.call(this, reason);
    });
    diagnostics = await startStartupCpuProfiling({ enabled: true, outputRoot: root });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stop).toHaveBeenCalledExactlyOnceWith("hard-timeout");
    // Timed out, but still writing: a quit now must wait for it.
    expect(diagnostics!.isRecording()).toBe(true);
    let complete = false;
    const stopping = diagnostics!.stop();
    void stopping.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toBe(false);
    release();
    await stopping;
    expect(complete).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for renderer startup before stopping and ignores a late load event", async () => {
    vi.useFakeTimers();
    let release!: (started: boolean) => void;
    vi.spyOn(RendererStartupCpuProfiler.prototype, "start").mockReturnValue(
      new Promise<boolean>((resolve) => { release = resolve; })
    );
    const stop = vi.spyOn(RendererStartupCpuProfiler.prototype, "stop").mockResolvedValue(true);
    const contents = new EventEmitter();
    const window = { webContents: contents } as unknown as BrowserWindow;
    diagnostics = await startStartupCpuProfiling({ enabled: true, outputRoot: root });
    diagnostics!.attachFirstWindow(window);
    const stopping = diagnostics!.stop();
    contents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).not.toHaveBeenCalled();
    release(true);
    await stopping;
    expect(stop).toHaveBeenCalledExactlyOnceWith("app-quit");
    expect(vi.getTimerCount()).toBe(0);
  });

  describe.each(["hard-timeout", "post-load-elapsed"])("%s completion", (reason) => {
    it.each([
      ["Profiler.enable", "resolve"],
      ["Profiler.start", "resolve"],
      ["Profiler.enable", "reject"],
      ["Profiler.start", "reject"]
    ])("abandons hung %s at the hard deadline and ignores late %s", async (command, settlement) => {
      vi.useFakeTimers();
      vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_POST_LOAD_MS", "5000");
      vi.stubEnv("PWRGIT_STARTUP_CPU_PROFILING_QUIT_ON_COMPLETE", "1");
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const pendingCommand = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      let attached = false;
      const debuggerTarget = {
        attach: () => { attached = true; },
        detach: vi.fn(() => { attached = false; }),
        isAttached: () => attached,
        on: vi.fn(),
        off: vi.fn(),
        sendCommand: vi.fn((method: string) => method === command ? pendingCommand : Promise.resolve())
      };
      const contents = Object.assign(new EventEmitter(), {
        debugger: debuggerTarget,
        isDestroyed: () => false
      });
      const mainStop = vi.spyOn(MainProcessCpuProfiler.prototype, "stop");
      const rendererStart = vi.spyOn(RendererStartupCpuProfiler.prototype, "start");
      diagnostics = await startStartupCpuProfiling({ enabled: true, outputRoot: root });
      diagnostics!.attachFirstWindow({ webContents: contents } as unknown as BrowserWindow);
      if (reason === "post-load-elapsed") contents.emit("did-finish-load");
      try {
        await vi.advanceTimersByTimeAsync(14_999);
        expect(debuggerTarget.sendCommand).toHaveBeenCalledWith(command);
        expect(mainStop).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(mainStop).toHaveBeenCalledExactlyOnceWith(reason);
        await diagnostics!.stop(); // Joins the timer's completion.
        expect(debuggerTarget.detach).toHaveBeenCalledOnce();
        expect(app.quit).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);

        const [directory] = await readdir(root);
        const manifestPath = join(root, directory!, "session.json");
        const manifestBefore = await readFile(manifestPath, "utf8");
        const manifest = JSON.parse(manifestBefore);
        expect(manifest.status).toBe("partial");
        expect(manifest.mainProfile.capturedAt).toEqual(expect.any(String));
        expect(manifest.rendererProfile.capturedAt).toBeNull();
        expect(manifest.completedAt).toEqual(expect.any(String));
        const profile = JSON.parse(await readFile(join(root, directory!, "main.cpuprofile"), "utf8"));
        expect(profile.nodes.length).toBeGreaterThan(0);
        const eventsPath = join(root, directory!, "events.ndjson");
        const eventsBefore = await readFile(eventsPath, "utf8");
        const commandsBefore = debuggerTarget.sendCommand.mock.calls.length;
        if (settlement === "resolve") resolve();
        else reject(new Error("late inspector failure"));
        await expect(rendererStart.mock.results[0]!.value).resolves.toBe(false);
        expect(debuggerTarget.sendCommand).toHaveBeenCalledTimes(commandsBefore);
        expect(await readFile(eventsPath, "utf8")).toBe(eventsBefore);
        expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
        expect(app.quit).toHaveBeenCalledOnce();
      } finally {
        resolve(); // Also releases startup if an assertion fails before the deadline.
      }
    });
  });
});

describe("DiagnosticsManager.hasPendingWork", () => {
  it("is true while a sync may start a monitor, and false with nothing running", async () => {
    const manager = new DiagnosticsManager({
      outputRoot: tmpdir(),
      getDiagnostics: () => DIAGNOSTICS_DEFAULTS,
      onHotCpuHeapSnapshotLimitReached: () => undefined
    });
    expect(manager.hasPendingWork()).toBe(false);
    manager.sync();
    expect(manager.hasPendingWork()).toBe(true);
    await manager.shutdown();
    expect(manager.hasPendingWork()).toBe(false);
  });
});
