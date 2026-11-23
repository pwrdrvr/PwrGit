import { readAppMetrics } from "./app-metrics";
// PwrGit's orchestration layer over the ported PwrAgnt diagnostics: resolves
// configs from Settings (+ PWRGIT_* env), runs the main-process heap monitor,
// attaches per-window renderer heap monitors and hot-CPU profilers, restarts
// them when Settings change, and drives the startup CPU profiling flow.
import fs from "node:fs/promises";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { app, contentTracing, type BrowserWindow } from "electron";
import type {
  DiagnosticsSettings,
  HotCpuProfileCapturedEvent,
  StartupCpuProfileArtifact,
  StartupCpuProfileCapturedEvent
} from "@pwrgit/shared";
import { QUIT_FLUSH_DEADLINE_MS } from "../bounded-shutdown";
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
import { createHotCpuProfileSession, type HotCpuProfileSession } from "./hot-cpu-profile-session";
import { HotCpuProfiler } from "./hot-cpu-profiler";
import { ChromiumTrace, ChromiumTraceStopError } from "./chromium-trace";
import { createMainProcessHotCpuTarget } from "./main-process-hot-cpu-target";
import { resolveStartupCpuProfileConfig } from "./startup-cpu-profile-config";
import {
  createStartupCpuProfileSession,
  type StartupCpuProfileSession
} from "./startup-cpu-profile-session";
import { MainProcessCpuProfiler } from "./main-process-cpu-profiler";
import { RendererStartupCpuProfiler } from "./renderer-startup-cpu-profiler";
import { watchResourceUsage } from "./resource-monitor";
import { resolveResourceUsageWindow, resourceUsageExpiry } from "./resource-usage-window";

/** Longest wait between wall-clock checks of a recording's expiry. Timers run
 *  on a clock that can pause while the machine sleeps; index.ts re-checks on
 *  resume (`recheckResourceUsage`), and this cap is only the backstop. */
const RESOURCE_EXPIRY_CHECK_MAX_MS = 60 * 60_000;

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
  profileId: string | null;
  heapMonitor: RendererHeapMonitor | null;
  heapSessionDir: string | null;
  hotCpuProfiler: HotCpuProfiler | null;
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
  private stopResourceMonitoring: (() => Promise<void>) | null = null;
  private resourceExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Expiry granted to a recording that was on with none stored, kept here
   *  too so it still ends if persisting it failed. */
  private unboundedResourceExpiresAtMs: number | null = null;
  /** Main-owned diagnostics writes (resource recording expiry). index.ts
   *  persists the patch and broadcasts settings:changed; it must not re-sync. */
  private readonly persistDiagnostics: ((patch: Partial<DiagnosticsSettings>) => void) | undefined;
  private readonly outputRoot: string;
  private readonly getDiagnostics: () => DiagnosticsSettings;
  private readonly usesLegacyHotCpuSettings: (() => boolean) | undefined;
  private readonly onHotCpuProfileCaptured: ((event: HotCpuProfileCapturedEvent, profileId: string | null) => void | Promise<void>) | undefined;
  /** Persist "captureHeapSnapshot off" after a session hits its snapshot
   *  limit (mirrors PwrAgnt's auto-disable so the next arm doesn't refill). */
  private readonly onHotCpuHeapSnapshotLimitReached: () => void;

  private readonly windows = new Map<number, WindowEntry>();
  private mainHeapMonitor: MainProcessHeapMonitor | null = null;
  private mainHeapSessionDir: string | null = null;
  private mainHotCpuProfiler: HotCpuProfiler | null = null;
  private mainHotCpuSessionDir: string | null = null;
  private heapConfig: HeapMonitorConfig = { enabled: false };
  private hotCpuConfig: HotCpuProfileConfig = { enabled: false };
  private heapConfigKey = "";
  private hotCpuConfigKey = "";
  private syncQueue: Promise<void> = Promise.resolve();
  private pendingSyncs = 0;
  private shuttingDown = false;
  private chromiumTraceEnabled = false;
  private reconfiguringRenderers = false;
  private readonly chromiumTrace: ChromiumTrace;

  constructor(options: {
    outputRoot: string;
    chromiumTraceWorker?: string;
    getDiagnostics: () => DiagnosticsSettings;
    usesLegacyHotCpuSettings?: () => boolean;
    onHotCpuProfileCaptured?: (event: HotCpuProfileCapturedEvent, profileId: string | null) => void | Promise<void>;
    onHotCpuHeapSnapshotLimitReached: () => void;
    persistDiagnostics?: (patch: Partial<DiagnosticsSettings>) => void;
  }) {
    this.outputRoot = options.outputRoot;
    this.chromiumTrace = new ChromiumTrace(
      () => contentTracing, (message, error) => log.warn(message, error),
      { workerModule: options.chromiumTraceWorker }
    );
    this.persistDiagnostics = options.persistDiagnostics;
    this.getDiagnostics = options.getDiagnostics;
    this.usesLegacyHotCpuSettings = options.usesLegacyHotCpuSettings;
    this.onHotCpuProfileCaptured = options.onHotCpuProfileCaptured;
    this.onHotCpuHeapSnapshotLimitReached =
      options.onHotCpuHeapSnapshotLimitReached;
  }

  /** Track a profile window; start monitors on it if diagnostics are live. */
  attachWindow(window: BrowserWindow, profileId: string | null = null): void {
    const id = window.webContents.id;
    if (this.windows.has(id)) return;

    const entry: WindowEntry = {
      window,
      profileId,
      heapMonitor: null,
      heapSessionDir: null,
      hotCpuProfiler: null,
      hotCpuSessionDir: null
    };
    this.windows.set(id, entry);
    window.on("closed", () => {
      this.enqueueSync(async () => {
        try {
          await entry.heapMonitor?.stop("window-closed");
          await discardSessionIfEmpty(entry.heapSessionDir);
          await entry.hotCpuProfiler?.stop("window-closed");
          await discardSessionIfEmpty(entry.hotCpuSessionDir);
        } finally {
          this.windows.delete(id);
          await this.reconcileChromiumTrace();
        }
      });
    });

    this.enqueueSync(async () => {
      if (this.heapConfig.enabled) {
        await this.startWindowHeapMonitor(entry, this.heapConfig);
      }
      if (this.hotCpuConfig.enabled) {
        await this.startWindowHotCpuProfiler(entry, this.hotCpuConfig);
      }
      await this.reconcileChromiumTrace();
    });
  }

  /** The first window is a prospective renderer. Only wait for the bounded
   * native trace start, not a full sync of unrelated diagnostics. */
  async prepareFirstRendererTrace(): Promise<void> {
    const settings = this.getDiagnostics();
    if (!settings.hotCpuProfilingCaptureChromiumTrace || this.shuttingDown) return;
    const { heapConfig, hotCpuConfig } = this.resolveMonitorConfigs(settings);
    if (hotCpuConfig.enabled && !heapConfig.enabled) await this.chromiumTrace.setArmed(true);
  }

  /** Re-resolve configs from Settings and start/stop/restart monitors. */
  sync(): Promise<void> {
    // An explicit opt-out cancels immediately, even if a monitor is stopping
    // on the diagnostics queue and has yet to finish its CPU profile.
    const disarmTrace = this.getDiagnostics().hotCpuProfilingCaptureChromiumTrace
      ? undefined : this.chromiumTrace.setArmed(false);
    this.enqueueSync(async () => {
      await disarmTrace;
      await this.syncInner();
    });
    return this.syncQueue;
  }

  limitTraceShutdown(remainingMs: number): void {
    // Leave time to terminate the worker and remove private scratch files.
    this.chromiumTrace.beginShutdown(remainingMs - 1_000);
  }

  /** Stop everything. Resolves once final events/manifests are flushed —
   *  index.ts drains this (with a timeout) before windows close. */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.limitTraceShutdown(QUIT_FLUSH_DEADLINE_MS);
    this.clearResourceExpiryTimer();
    this.enqueueSync(async () => {
      try {
        await this.stopResourceUsage();
        await this.stopHeapMonitoring("app-quit");
        await this.stopHotCpuProfiling("app-quit");
      } finally {
        this.chromiumTraceEnabled = false;
        await this.chromiumTrace.setArmed(false);
      }
    });
    return this.syncQueue.finally(() => this.chromiumTrace.clearShutdownTimer());
  }

  /** Whether `shutdown` has anything to flush: a monitor or profiler is
   *  running, or a queued sync may be about to start one. Quit is deferred
   *  for the flush only when this is true. */
  hasPendingWork(): boolean {
    if (this.pendingSyncs > 0 || this.mainHeapMonitor !== null || this.mainHotCpuProfiler !== null || this.stopResourceMonitoring !== null || this.chromiumTraceEnabled) return true;
    for (const entry of this.windows.values()) {
      if (entry.heapMonitor !== null || entry.hotCpuProfiler !== null) return true;
    }
    return false;
  }

  /** Re-check the resource recording's stop time by wall clock, e.g. after
   *  the system resumes from sleep, when a pending timer may be late. */
  recheckResourceUsage(): void {
    if (this.shuttingDown) return;
    this.enqueueSync(() => this.syncResourceUsage(this.getDiagnostics()));
  }

  /** Resolves once work already queued (including a timer's expiry check)
   *  has run, without queueing a sync of its own. */
  whenIdle(): Promise<void> {
    return this.syncQueue;
  }

  private enqueueSync(task: () => Promise<void>): void {
    this.pendingSyncs += 1;
    this.syncQueue = this.syncQueue
      .then(task)
      .catch((error) => {
        log.error("diagnostics sync failed", error);
      })
      .finally(() => {
        this.pendingSyncs -= 1;
      });
  }

  private async syncInner(): Promise<void> {
    if (this.shuttingDown) return;

    const settings = this.getDiagnostics();
    await this.syncResourceUsage(settings);
    const { heapConfig, hotCpuConfig } = this.resolveMonitorConfigs(settings);
    const heapKey = JSON.stringify(heapConfig);
    const hotCpuKey = JSON.stringify(hotCpuConfig);
    const heapChanged = heapKey !== this.heapConfigKey;
    const hotCpuChanged = hotCpuKey !== this.hotCpuConfigKey;
    const previous = this.hotCpuConfig;
    const reconfigureRules = hotCpuChanged && previous?.enabled && hotCpuConfig.enabled &&
      previous.outputRoot === hotCpuConfig.outputRoot && previous.startDelayMs === hotCpuConfig.startDelayMs &&
      previous.profileDurationMs === hotCpuConfig.profileDurationMs && previous.cooldownMs === hotCpuConfig.cooldownMs &&
      previous.maxProfiles === hotCpuConfig.maxProfiles && previous.captureHeapSnapshot === hotCpuConfig.captureHeapSnapshot &&
      previous.heapSnapshotLimit === hotCpuConfig.heapSnapshotLimit;
    const restartHotCpu = hotCpuChanged && !reconfigureRules;
    this.chromiumTraceEnabled = settings.hotCpuProfilingCaptureChromiumTrace &&
      hotCpuConfig.enabled && !heapConfig.enabled;
    // Stop rearming first. The old profilers still own their active triggers
    // and can export before we discard an unclaimed trace below.
    this.reconfiguringRenderers = heapChanged || restartHotCpu;
    try {
      if (heapChanged) {
        // Heap monitoring owns the renderer debugger while enabled.
        await this.stopWindowHotCpuProfilers("heap-config-changed");
        await this.stopHeapMonitoring("config-changed");
        this.heapConfig = heapConfig;
        this.heapConfigKey = heapKey;
        if (heapConfig.enabled) {
          await this.startHeapMonitoring(heapConfig);
        }
      }

      if (restartHotCpu) await this.stopHotCpuProfiling("config-changed");
      if (hotCpuChanged) {
        this.hotCpuConfig = hotCpuConfig;
        this.hotCpuConfigKey = hotCpuKey;
        if (hotCpuConfig.enabled) {
          if (reconfigureRules) {
            this.mainHotCpuProfiler?.reconfigureRules(hotCpuConfig);
            for (const entry of this.windows.values()) entry.hotCpuProfiler?.reconfigureRules(hotCpuConfig);
          } else {
            await this.startMainHotCpuProfiler(hotCpuConfig);
          }
        }
      }
      if ((heapChanged || restartHotCpu) && hotCpuConfig.enabled) {
        for (const entry of this.windows.values()) {
          await this.startWindowHotCpuProfiler(entry, hotCpuConfig);
        }
      }
    } finally {
      this.reconfiguringRenderers = false;
      await this.reconcileChromiumTrace();
    }
  }

  private resolveMonitorConfigs(settings: DiagnosticsSettings) {
    const heapConfig = resolveHeapMonitorConfig({
      enabled: settings.heapMonitorEnabled,
      outputRoot: this.outputRoot
    });
    const hotCpuConfig = resolveHotCpuProfileConfig({
      enabled: settings.hotCpuProfilingEnabled,
      outputRoot: this.outputRoot,
      startDelayMs: settings.hotCpuProfilingStartDelayMs,
      rules: settings.hotCpuProfilingRules,
      legacySettings: this.usesLegacyHotCpuSettings?.() ?? false,
      captureHeapSnapshot: settings.hotCpuProfilingCaptureHeapSnapshot,
      heapSnapshotLimit: settings.hotCpuProfilingHeapSnapshotLimit
    });
    return { heapConfig, hotCpuConfig };
  }

  private async reconcileChromiumTrace(): Promise<void> {
    if (this.reconfiguringRenderers || this.shuttingDown) return;
    const windows = [...this.windows.values()];
    if (this.chromiumTraceEnabled && this.getDiagnostics().hotCpuProfilingCaptureChromiumTrace) {
      if (windows.some((entry) => entry.hotCpuProfiler?.canCaptureAnotherProfile())) {
        await this.chromiumTrace.setArmed(true);
        return;
      }
      // A renderer at its limit may still be exporting its final trigger.
      if (windows.some((entry) => entry.hotCpuProfiler?.hasTriggeredProfile())) return;
    }
    await this.chromiumTrace.setArmed(false);
  }

  /**
   * Run resource recording only inside its window: from the moment it was
   * turned on until the stored expiry, across restarts. At expiry, stop
   * sampling and turn the setting off; the samples already written stay on
   * disk under the monitor's own 24-hour retention.
   */
  private async syncResourceUsage(settings: DiagnosticsSettings): Promise<void> {
    this.clearResourceExpiryTimer();
    if (this.shuttingDown) return;
    const now = Date.now();
    let window = resolveResourceUsageWindow(settings, now);
    if (window.state === "unbounded") {
      if (this.unboundedResourceExpiresAtMs === null) {
        const expiresAt = resourceUsageExpiry(now);
        this.unboundedResourceExpiresAtMs = Date.parse(expiresAt);
        log.info("resource recording had no stop time; it stops 24 hours from now", { expiresAt });
        this.persistDiagnostics?.({ resourceUsageExpiresAt: expiresAt });
      }
      window = now < this.unboundedResourceExpiresAtMs
        ? { state: "recording", expiresAtMs: this.unboundedResourceExpiresAtMs }
        : { state: "expired" };
    } else {
      this.unboundedResourceExpiresAtMs = null;
    }

    if (window.state === "recording") {
      this.stopResourceMonitoring ??= watchResourceUsage(path.join(this.outputRoot, "resources"));
      this.scheduleResourceExpiryCheck(window.expiresAtMs - now);
      return;
    }
    // Persist before awaiting the sampler's last write: `settings` is only
    // current until then, and a turn-on that lands during the await must not
    // be overwritten with "off".
    if (window.state === "expired") {
      log.info("resource recording reached its 24-hour limit; samples are kept", {
        directory: path.join(this.outputRoot, "resources")
      });
      this.persistDiagnostics?.({ resourceUsageEnabled: false, resourceUsageExpiresAt: null });
    }
    await this.stopResourceUsage();
  }

  private scheduleResourceExpiryCheck(remainingMs: number): void {
    const timer = setTimeout(() => {
      if (this.resourceExpiryTimer !== timer) return;
      this.resourceExpiryTimer = null;
      this.recheckResourceUsage();
    }, Math.min(Math.max(remainingMs, 0), RESOURCE_EXPIRY_CHECK_MAX_MS));
    timer.unref?.();
    this.resourceExpiryTimer = timer;
  }

  private clearResourceExpiryTimer(): void {
    if (this.resourceExpiryTimer !== null) clearTimeout(this.resourceExpiryTimer);
    this.resourceExpiryTimer = null;
  }

  private async stopResourceUsage(): Promise<void> {
    const stop = this.stopResourceMonitoring;
    this.stopResourceMonitoring = null;
    await stop?.();
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
    if (this.mainHotCpuProfiler !== null) {
      await this.mainHotCpuProfiler.stop(reason);
      this.mainHotCpuProfiler = null;
      await discardSessionIfEmpty(this.mainHotCpuSessionDir);
      this.mainHotCpuSessionDir = null;
    }
    await this.stopWindowHotCpuProfilers(reason);
  }

  private async stopWindowHotCpuProfilers(reason: string): Promise<void> {
    for (const entry of this.windows.values()) {
      if (entry.hotCpuProfiler !== null) {
        await entry.hotCpuProfiler.stop(reason);
        entry.hotCpuProfiler = null;
        await discardSessionIfEmpty(entry.hotCpuSessionDir);
        entry.hotCpuSessionDir = null;
      }
    }
  }

  private async startMainHotCpuProfiler(
    config: Extract<HotCpuProfileConfig, { enabled: true }>
  ): Promise<void> {
    const created = await createHotCpuProfileSession({ config, target: "main", versions: versions() });
    if (!created.ok) {
      log.error(created.message);
      return;
    }
    this.mainHotCpuSessionDir = created.session.directoryPath;
    this.mainHotCpuProfiler = new HotCpuProfiler({
      config, session: created.session,
      getAppMetrics: readAppMetrics,
      target: createMainProcessHotCpuTarget(),
      onProfileWritten: (event) => this.onHotCpuProfileCaptured?.(event, null)
    });
    log.info("main hot CPU session directory", { directory: created.session.directoryPath });
    await this.mainHotCpuProfiler.start();
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
    entry.hotCpuProfiler = new HotCpuProfiler({
      config,
      getAppMetrics: readAppMetrics,
      session: session.session,
      target: {
        debugger: contents.debugger,
        getOSProcessId: () => contents.getOSProcessId(),
        isDestroyed: () => contents.isDestroyed(),
        takeHeapSnapshot: (filePath) => contents.takeHeapSnapshot(filePath)
      },
      onProfileTriggered: (filePath, triggerAtMs, triggerMonotonicMs) =>
        this.startChromiumTraceCapture(session.session, filePath, triggerAtMs, triggerMonotonicMs, config.profileDurationMs),
      onProfileFinished: () => { void this.reconcileChromiumTrace(); },
      onProfileWritten: (event) => this.onHotCpuProfileCaptured?.(event, entry.profileId),
      onHeapSnapshotLimitReached: () => {
        this.onHotCpuHeapSnapshotLimitReached();
      }
    });
    await entry.hotCpuProfiler.start();
  }

  private startChromiumTraceCapture(
    session: HotCpuProfileSession, profilePath: string, triggerAtMs: number,
    triggerMonotonicMs: number, profileDurationMs: number
  ): ((profileWritten: boolean) => Promise<void>) | undefined {
    if (!this.getDiagnostics().hotCpuProfilingCaptureChromiumTrace) return;
    const filename = `${path.parse(profilePath).name}.trace.json`;
    let completeProfile!: (written: boolean) => void;
    const profileWritten = new Promise<boolean>((resolve) => { completeProfile = resolve; });
    const capture = this.chromiumTrace.capture(
      path.join(session.directoryPath, filename), triggerMonotonicMs,
      async () => await profileWritten && this.getDiagnostics().hotCpuProfilingCaptureChromiumTrace,
      profileDurationMs
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const timing = error instanceof ChromiumTraceStopError ? error.timing : undefined;
      log.warn("Could not save Chromium trace", { error: message, ...timing });
      return { status: "failed" as const, error: message, ...timing };
    }).finally(() => {
      // A timed-out trace must release the slot even if its renderer never
      // finishes the CPU profile and never calls onProfileFinished.
      void this.reconcileChromiumTrace();
    });
    return async (written) => {
      completeProfile(written);
      const result = await capture;
      if (!written || (result.status === "skipped" && result.reason === "canceled")) return;
      if (result.status === "written") await session.registerArtifact(filename);
      await session.appendEvent({
        capturedAt: new Date().toISOString(),
        type: `chromium-trace-${result.status}`,
        detail: { filename, triggerAtMs, ...result }
      });
    };
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
  /** Finish active captures, or join completion already started by a timer. */
  stop: () => Promise<void>;
  /** True until the capture has been written, however it finished. */
  isRecording: () => boolean;
};

/** What the startup session actually left on disk, in a fixed order. A
 *  profiler that reported success but wrote nothing is listed as missing. */
async function listStartupCpuArtifacts(session: StartupCpuProfileSession): Promise<{
  artifacts: StartupCpuProfileArtifact[];
  missing: StartupCpuProfileCapturedEvent["missing"];
}> {
  const candidates: Array<[StartupCpuProfileArtifact["kind"], string]> = [
    ["main-profile", session.mainProfilePath],
    ["renderer-profile", session.rendererProfilePath],
    ["heap-snapshot", session.mainHeapSnapshotPath],
    ["heap-snapshot", session.rendererHeapSnapshotPath],
    ["manifest", session.manifestPath],
    ["events", session.eventsPath]
  ];
  const present = await Promise.all(candidates.map(async ([, filePath]) =>
    fs.stat(filePath).then((stat) => stat.isFile() && stat.size > 0, () => false)
  ));
  const artifacts = candidates
    .filter((_, index) => present[index])
    .map(([kind, filePath]) => ({ kind, filename: path.basename(filePath), path: filePath }));
  const missing = (["main-profile", "renderer-profile"] as const)
    .filter((kind) => !artifacts.some((artifact) => artifact.kind === kind));
  return { artifacts, missing };
}

export async function startStartupCpuProfiling(options: {
  enabled: boolean;
  outputRoot: string;
  /** Called once when the session is closed and its manifest written. */
  onCompleted?: (event: StartupCpuProfileCapturedEvent) => void;
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
  const startedAt = new Date().toISOString();
  log.info("startup CPU session directory", {
    directory: session.directoryPath
  });

  const mainProfiler = new MainProcessCpuProfiler({ session });
  const mainStarted = await mainProfiler.start();
  if (!mainStarted) {
    log.warn("continuing startup profiling with renderer only");
  }

  let rendererProfiler: RendererStartupCpuProfiler | null = null;
  let rendererStarted: Promise<boolean> | null = null;
  let rendererWindow: BrowserWindow | null = null;
  let finished = false;
  let finishPromise: Promise<void> | undefined;
  let written = false;
  let postLoadTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let expireRendererStart!: () => void;
  const rendererStartDeadline = new Promise<false>((resolve) => {
    expireRendererStart = () => resolve(false);
  });

  const finishInner = async (reason: string): Promise<void> => {
    if (postLoadTimer) clearTimeout(postLoadTimer);
    // A post-load completion can begin before renderer startup answers. Keep
    // the original hard deadline alive until that wait settles; the hard-timeout
    // completion itself must never wait on an unresponsive renderer startup.
    const rendererReady = await Promise.race([rendererStarted, rendererStartDeadline]);
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
    const rendererOk = (await rendererProfiler?.stop(reason)) ?? false;
    const mainOk = await mainProfiler.stop(reason);

    // Quit flushes active captures; it must not start a new synchronous heap
    // snapshot, which would prevent the shutdown deadline from running.
    if (config.captureHeapSnapshots && reason !== "app-quit") {
      try {
        const written = writeHeapSnapshot(session.mainHeapSnapshotPath);
        await session.registerHeapSnapshot(path.basename(written));
      } catch (error) {
        log.error("startup main heap snapshot failed", error);
      }
      if (rendererReady && rendererWindow !== null && !rendererWindow.isDestroyed()) {
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

    const status = mainOk && rendererOk ? "completed" : mainOk || rendererOk ? "partial" : "failed";
    const completedAt = new Date().toISOString();
    await session.complete({ status, completedAt });
    log.info("startup CPU profiling finished", {
      reason,
      status,
      directory: session.directoryPath
    });
    if (options.onCompleted !== undefined) {
      try {
        options.onCompleted({
          sessionId: session.id,
          sessionDirectory: session.directoryPath,
          sessionDirectoryName: session.directoryName,
          status,
          reason,
          armedBy: config.armedBy,
          startedAt,
          completedAt,
          ...await listStartupCpuArtifacts(session)
        });
      } catch (error) {
        log.error("startup CPU completion notice failed", error);
      }
    }

    if (config.quitOnComplete) {
      app.quit();
    }
  };

  const finish = (reason: string): Promise<void> => {
    finished = true;
    finishPromise ??= Promise.resolve()
      .then(() => finishInner(reason))
      .finally(() => {
        written = true;
      });
    return finishPromise;
  };

  hardTimeoutTimer = setTimeout(() => {
    expireRendererStart();
    void finish("hard-timeout");
  }, config.hardTimeoutMs);

  return {
    stop: () => finish("app-quit"),
    isRecording: () => !written,
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
      rendererStarted = rendererProfiler.start();
      window.webContents.once("did-finish-load", () => {
        if (finished) return;
        postLoadTimer = setTimeout(() => {
          void finish("post-load-elapsed");
        }, config.postLoadDurationMs);
      });
    }
  };
}
