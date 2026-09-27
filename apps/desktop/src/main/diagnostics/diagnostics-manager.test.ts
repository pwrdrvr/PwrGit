import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStartupCpuProfiling, type StartupCpuDiagnostics } from "./diagnostics-manager";
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
    const stopping = diagnostics!.stop();
    expect(diagnostics!.stop()).toBe(stopping);
    await stopping;

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
});
