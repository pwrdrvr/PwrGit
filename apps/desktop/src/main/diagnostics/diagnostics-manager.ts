// PwrGit's orchestration layer over the ported PwrAgnt diagnostics: resolves
// configs from Settings (+ PWRGIT_* env), runs the main-process heap monitor,
// attaches per-window renderer heap monitors and hot-CPU profilers, restarts
// them when Settings change, and drives the startup CPU profiling flow.
import fs from "node:fs/promises";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { app, type BrowserWindow } from "electron";
import type { DiagnosticsSettings } from "@pwrgit/shared";
import { getDiagLogger } from "./diag-log";
import {
  resolveHeapMonitorConfig,
  type HeapMonitorConfig
} from "./heap-monitor-config";
import { createHeapSession, type HeapSessionVersions } from "./heap-session";
import { MainProcessHeapMonitor } from "./main-process-heap-monitor";
import { RendererHeapMonitor } from "./renderer-heap-monitor";
import {
  resolveHotCpuProfileConfig,
  type HotCpuProfileConfig
} from "./hot-cpu-profile-config";
import { createHotCpuProfileSession } from "./hot-cpu-profile-session";
import { RendererHotCpuProfiler } from "./renderer-hot-cpu-profiler";
import { resolveStartupCpuProfileConfig } from "./startup-cpu-profile-config";
import { createStartupCpuProfileSession } from "./startup-cpu-profile-session";
import { MainProcessCpuProfiler } from "./main-process-cpu-profiler";
import { RendererStartupCpuProfiler } from "./renderer-startup-cpu-profiler";

const log = getDiagLogger("pwrgit:diagnostics");

function versions(): HeapSessionVersions {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    nodeVersion: process.versions.node ?? "unknown"
  };
}

type WindowEntry = {
  window: BrowserWindow;
  heapMonitor: RendererHeapMonitor | null;
  heapSessionDir: string | null;
  hotCpuProfiler: RendererHotCpuProfiler | null;
  hotCpuSessionDir: string | null;
};

/**
 * Config tweaks restart monitoring with a fresh session directory, so rapid
 * knob changes would otherwise litter the diagnostics root with empty dirs.
 * After a stop, drop the session if it only ever wrote its manifest/events —
 * any sample or artifact (.cpuprofile/.heapsnapshot/samples.ndjson) keeps it.
 */
async function discardSessionIfEmpty(
  directoryPath: string | null
): Promise<void> {
  if (directoryPath === null) return;
  try {
    const entries = await fs.readdir(directoryPath);
    const meaningful = entries.filter(
      (name) => name !== "session.json" && name !== "events.ndjson"
    );
    if (meaningful.length > 0) return;
    await fs.rm(directoryPath, { recursive: true, force: true });
  } catch {
    // Keeping an empty directory is harmless; never fail a stop over cleanup.
  }
}

export class DiagnosticsManager {
  private readonly outputRoot: string;
  private readonly getDiagnostics: () => DiagnosticsSettings;
  /** Persist "captureHeapSnapshot off" after a session hits its snapshot
   *  limit (mirrors PwrAgnt's auto-disable so the next arm doesn't refill). */
  private readonly onHotCpuHeapSnapshotLimitReached: () => void;

  private readonly windows = new Map<number, WindowEntry>();
  private mainHeapMonitor: MainProcessHeapMonitor | null = null;
  private mainHeapSessionDir: string | null = null;
  private heapConfig: HeapMonitorConfig = { enabled: false };
  private hotCpuConfig: HotCpuProfileConfig = { enabled: false };
  private heapConfigKey = "";
  private hotCpuConfigKey = "";
  private syncQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(options: {
    outputRoot: string;
    getDiagnostics: () => DiagnosticsSettings;
    onHotCpuHeapSnapshotLimitReached: () => void;
  }) {
    this.outputRoot = options.outputRoot;
    this.getDiagnostics = options.getDiagnostics;
    this.onHotCpuHeapSnapshotLimitReached =
      options.onHotCpuHeapSnapshotLimitReached;
  }

  /** Track a profile window; start monitors on it if diagnostics are live. */
  attachWindow(window: BrowserWindow): void {
    const id = window.webContents.id;
    if (this.windows.has(id)) return;

    const entry: WindowEntry = {
      window,
      heapMonitor: null,
      heapSessionDir: null,
      hotCpuProfiler: null,
      hotCpuSessionDir: null
    };
    this.windows.set(id, entry);
    window.on("closed", () => {
      const closing = this.windows.get(id);
      this.windows.delete(id);
      if (closing !== undefined) {
        void closing.heapMonitor
          ?.stop("window-closed")
          .then(() => discardSessionIfEmpty(closing.heapSessionDir));
        void closing.hotCpuProfiler
          ?.stop("window-closed")
          .then(() => discardSessionIfEmpty(closing.hotCpuSessionDir));
      }
    });

    this.enqueueSync(async () => {
      if (this.heapConfig.enabled) {
        await this.startWindowHeapMonitor(entry, this.heapConfig);
      }
      if (this.hotCpuConfig.enabled) {
        await this.startWindowHotCpuProfiler(entry, this.hotCpuConfig);
      }
    });
  }

  /** Re-resolve configs from Settings and start/stop/restart monitors. */
  sync(): void {
    this.enqueueSync(() => this.syncInner());
  }

  /** Stop everything. Resolves once final events/manifests are flushed —
   *  index.ts drains this (with a timeout) in `will-quit`. */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.enqueueSync(async () => {
      await this.stopHeapMonitoring("app-quit");
      await this.stopHotCpuProfiling("app-quit");
    });
    return this.syncQueue;
  }

  private enqueueSync(task: () => Promise<void>): void {
    this.syncQueue = this.syncQueue.then(task).catch((error) => {
      log.error("diagnostics sync failed", error);
    });
  }

  private async syncInner(): Promise<void> {
    if (this.shuttingDown) return;

    const settings = this.getDiagnostics();
    const heapConfig = resolveHeapMonitorConfig({
      enabled: settings.heapMonitorEnabled,
      outputRoot: this.outputRoot
    });
    const hotCpuConfig = resolveHotCpuProfileConfig({
      enabled: settings.hotCpuProfilingEnabled,
      outputRoot: this.outputRoot,
      startDelayMs: settings.hotCpuProfilingStartDelayMs,
      triggerMode: settings.hotCpuProfilingTriggerMode,
      captureHeapSnapshot: settings.hotCpuProfilingCaptureHeapSnapshot,
      heapSnapshotLimit: settings.hotCpuProfilingHeapSnapshotLimit
    });

    const heapKey = JSON.stringify(heapConfig);
    if (heapKey !== this.heapConfigKey) {
      await this.stopHeapMonitoring("config-changed");
      this.heapConfig = heapConfig;
      this.heapConfigKey = heapKey;
      if (heapConfig.enabled) {
        await this.startHeapMonitoring(heapConfig);
      }
    }

    const hotCpuKey = JSON.stringify(hotCpuConfig);
    if (hotCpuKey !== this.hotCpuConfigKey) {
      await this.stopHotCpuProfiling("config-changed");
      this.hotCpuConfig = hotCpuConfig;
      this.hotCpuConfigKey = hotCpuKey;
      if (hotCpuConfig.enabled) {
        for (const entry of this.windows.values()) {
          await this.startWindowHotCpuProfiler(entry, hotCpuConfig);
        }
      }
    }
  }

  private async startHeapMonitoring(
    config: Extract<HeapMonitorConfig, { enabled: true }>
  ): Promise<void> {
    const mainSession = await createHeapSession({
      config,
      label: "main",
      versions: versions()
    });
    if (!mainSession.ok) {
      log.error(mainSession.message);
    } else {
      this.mainHeapMonitor = new MainProcessHeapMonitor({
        session: mainSession.session,
        config
      });
      this.mainHeapSessionDir = mainSession.session.directoryPath;
      await this.mainHeapMonitor.start();
    }

    for (const entry of this.windows.values()) {
      await this.startWindowHeapMonitor(entry, config);
    }
  }

  private async stopHeapMonitoring(reason: string): Promise<void> {
    if (this.mainHeapMonitor !== null) {
      await this.mainHeapMonitor.stop(reason);
      this.mainHeapMonitor = null;
      await discardSessionIfEmpty(this.mainHeapSessionDir);
      this.mainHeapSessionDir = null;
    }
    for (const entry of this.windows.values()) {
      if (entry.heapMonitor !== null) {
        await entry.heapMonitor.stop(reason);
        entry.heapMonitor = null;
        await discardSessionIfEmpty(entry.heapSessionDir);
        entry.heapSessionDir = null;
      }
    }
  }

  private async startWindowHeapMonitor(
    entry: WindowEntry,
    config: Extract<HeapMonitorConfig, { enabled: true }>
  ): Promise<void> {
    if (entry.heapMonitor !== null || entry.window.isDestroyed()) return;

    const contents = entry.window.webContents;
    const session = await createHeapSession({
      config,
      label: `renderer-${contents.id}`,
      versions: versions()
    });
    if (!session.ok) {
      log.error(session.message);
      return;
    }

    entry.heapSessionDir = session.session.directoryPath;
    entry.heapMonitor = new RendererHeapMonitor({
      config,
      session: session.session,
      target: {
        debugger: contents.debugger,
        takeHeapSnapshot: (filePath) => contents.takeHeapSnapshot(filePath),
        isDestroyed: () => contents.isDestroyed()
      }
    });
    await entry.heapMonitor.start();
  }

  private async stopHotCpuProfiling(reason: string): Promise<void> {
    for (const entry of this.windows.values()) {
      if (entry.hotCpuProfiler !== null) {
        await entry.hotCpuProfiler.stop(reason);
        entry.hotCpuProfiler = null;
        await discardSessionIfEmpty(entry.hotCpuSessionDir);
        entry.hotCpuSessionDir = null;
      }
    }
  }

  private async startWindowHotCpuProfiler(
    entry: WindowEntry,
    config: Extract<HotCpuProfileConfig, { enabled: true }>
  ): Promise<void> {
    if (entry.hotCpuProfiler !== null || entry.window.isDestroyed()) return;

    const contents = entry.window.webContents;
    const session = await createHotCpuProfileSession({
      config,
      versions: versions()
    });
    if (!session.ok) {
      log.error(session.message);
      return;
    }
    log.info("hot CPU session directory", {
      directory: session.session.directoryPath
    });

    entry.hotCpuSessionDir = session.session.directoryPath;
    entry.hotCpuProfiler = new RendererHotCpuProfiler({
      config,
      getAppMetrics: () => app.getAppMetrics(),
      session: session.session,
      target: {
        debugger: contents.debugger,
        getOSProcessId: () => contents.getOSProcessId(),
        isDestroyed: () => contents.isDestroyed(),
        takeHeapSnapshot: (filePath) => contents.takeHeapSnapshot(filePath)
      },
      onHeapSnapshotLimitReached: () => {
        this.onHotCpuHeapSnapshotLimitReached();
      }
    });
    await entry.hotCpuProfiler.start();
  }
}

/**
 * Startup CPU profiling (boot-only, unlike the live-synced monitors above):
 * profiles the main process from now until `postLoadDurationMs` after the
 * first window finishes loading (hard timeout as a backstop), and the first
 * window's renderer alongside it.
 */
export type StartupCpuDiagnostics = {
  /** Bind the first window; starts the renderer profiler + completion timers. */
  attachFirstWindow: (window: BrowserWindow) => void;
};

export async function startStartupCpuProfiling(options: {
  enabled: boolean;
  outputRoot: string;
}): Promise<StartupCpuDiagnostics | null> {
  const config = resolveStartupCpuProfileConfig({
    enabled: options.enabled,
    outputRoot: options.outputRoot
  });
  if (!config.enabled) return null;

  const created = await createStartupCpuProfileSession({
    config,
    versions: versions()
  });
  if (!created.ok) {
    log.error(created.message);
    return null;
  }
  const session = created.session;
  log.info("startup CPU session directory", {
    directory: session.directoryPath
  });

  const mainProfiler = new MainProcessCpuProfiler({ session });
  const mainStarted = await mainProfiler.start();
  if (!mainStarted) {
    log.warn("continuing startup profiling with renderer only");
  }

  let rendererProfiler: RendererStartupCpuProfiler | null = null;
  let rendererWindow: BrowserWindow | null = null;
  let finished = false;
  let postLoadTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    if (postLoadTimer) clearTimeout(postLoadTimer);
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);

    const rendererOk = (await rendererProfiler?.stop(reason)) ?? false;
    const mainOk = await mainProfiler.stop(reason);

    if (config.captureHeapSnapshots) {
      try {
        const written = writeHeapSnapshot(session.mainHeapSnapshotPath);
        await session.registerHeapSnapshot(path.basename(written));
      } catch (error) {
        log.error("startup main heap snapshot failed", error);
      }
      if (rendererWindow !== null && !rendererWindow.isDestroyed()) {
        try {
          await rendererWindow.webContents.takeHeapSnapshot(
            session.rendererHeapSnapshotPath
          );
          await session.registerHeapSnapshot(
            path.basename(session.rendererHeapSnapshotPath)
          );
        } catch (error) {
          log.error("startup renderer heap snapshot failed", error);
        }
      }
    }

    await session.complete({
      status: mainOk && rendererOk ? "completed" : "partial",
      completedAt: new Date().toISOString()
    });
    log.info("startup CPU profiling finished", {
      reason,
      directory: session.directoryPath
    });

    if (config.quitOnComplete) {
      app.quit();
    }
  };

  hardTimeoutTimer = setTimeout(() => {
    void finish("hard-timeout");
  }, config.hardTimeoutMs);

  return {
    attachFirstWindow: (window) => {
      if (rendererWindow !== null || finished) return;
      rendererWindow = window;
      rendererProfiler = new RendererStartupCpuProfiler({
        session,
        target: {
          debugger: window.webContents.debugger,
          isDestroyed: () => window.webContents.isDestroyed()
        }
      });
      void rendererProfiler.start();
      window.webContents.once("did-finish-load", () => {
        postLoadTimer = setTimeout(() => {
          void finish("post-load-elapsed");
        }, config.postLoadDurationMs);
      });
    }
  };
}
