// Shared main/renderer recorder, ported from PwrAgent. Retains bounded
// pre-trigger history so short bursts are captured before CPU sampling notices.
import fs from "node:fs/promises";
import path from "node:path";
import type { Profiler } from "node:inspector";
import type { ProcessMetric } from "electron";
import type { HotCpuProfileCapturedEvent, HotCpuProfileHeapSnapshotArtifact } from "@pwrgit/shared";
import type { HotCpuProfileConfig } from "./hot-cpu-profile-config";
import type { HotCpuProfileSession } from "./hot-cpu-profile-session";
import { getDiagLogger } from "./diag-log";
import { joinCpuProfiles } from "./cpu-profile-history";
import { HotCpuRuleMatcher, type CpuInterval } from "./hot-cpu-rule-matcher";
import type { AppMetricsSample } from "./app-metrics";

const CHROME_DEBUGGER_PROTOCOL_VERSION = "1.3";
// Rotate only after evaluating the CPU sample, and retain the last complete
// window as well as the live one. A burst across a rotation stays available.
const RECORDING_WINDOW_MS = 30_000;

type Logger = Pick<Console, "info" | "warn" | "error">;

type HotCpuDebugger = {
  attach: (version: string) => void;
  detach: () => void;
  isAttached: () => boolean;
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
  off?: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
};

export type HotCpuTarget = {
  debugger: HotCpuDebugger;
  getOSProcessId: () => number;
  isDestroyed?: () => boolean;
  takeHeapSnapshot?: (filePath: string) => Promise<void>;
  readHeapUsage?: () => {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
};

type CpuBaseline = {
  pid: number;
  createdAt: number;
  atMs: number;
  cumulativeSeconds: number | undefined;
};

type ActiveProfileTrigger = Pick<
  HotCpuProfileCapturedEvent,
  | "matchedRules"
  | "triggerConsecutiveSamples"
  | "triggerCpuPercent"
  | "triggerMode"
  | "triggerThresholdPercent"
>;
type ProfileCompanion = (profileWritten: boolean) => Promise<void>;
type ProfileTriggerListener = (profilePath: string, triggerAtMs: number, triggerMonotonicMs: number) => ProfileCompanion | undefined;

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactFilename(filePath: string): string {
  return path.basename(filePath);
}

export class HotCpuProfiler {
  private readonly detachListener = (_event: unknown, reason: string) => {
    this.debuggerAttached = false;
    this.recording = false;
    this.previousRecording = null;
    void this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "debugger-detached",
      detail: { reason },
    });
    this.logger.warn("target debugger detached", {
      reason,
      target: this.session.target ?? "renderer",
      sessionDirectory: this.session.directoryPath,
    });
  };

  private config: Extract<HotCpuProfileConfig, { enabled: true }>;
  private readonly getAppMetrics: (reuseForMs: number) => AppMetricsSample | ProcessMetric[];
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly onHeapSnapshotLimitReached: (() => void | Promise<void>) | undefined;
  private readonly onSampleCaptured: (() => void) | undefined;
  private readonly onProfileTriggered: ProfileTriggerListener | undefined;
  private readonly onProfileFinished: (() => void) | undefined;
  private readonly onProfileWritten: ((event: HotCpuProfileCapturedEvent) => void | Promise<void>) | undefined;
  private readonly session: HotCpuProfileSession;
  private readonly target: HotCpuTarget;

  private startPromise: Promise<void> | null = null;
  private recording = false;
  private recordingStartedAtMs = 0;
  private recordingStartedAtMonotonicMs = 0;
  private previousRecording: Profiler.Profile | null = null;
  private previousRecordingStartedAtMs = 0;
  private previousRecordingStartedAtMonotonicMs = 0;
  private readonly matcher = new HotCpuRuleMatcher();
  private ruleRevision = 0;
  private waitingForFirstSample = true;
  private debuggerAttached = false;
  private heapSnapshotLimitReached = false;
  private heapSnapshotsCaptured = 0;
  private heapSnapshotMidTimer: ReturnType<typeof setTimeout> | null = null;
  private captureSamplePromise: Promise<void> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProfileAtMonotonicMs: number | null = null;
  private baseline: CpuBaseline | null = null;
  private profileDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private profileCount = 0;
  private shutdownPromise: Promise<void> | null = null;
  private stopProfilePromise: Promise<void> | null = null;
  private profiling = false;
  private samplingPausedForProfile = false;
  private activeProfileTrigger: ActiveProfileTrigger | null = null;
  private profileCompanion: ProfileCompanion | undefined;
  private activeProfileHeapSnapshots: HotCpuProfileHeapSnapshotArtifact[] = [];
  private activeProfileHeapSnapshotCaptures = new Set<Promise<void>>();
  private stopped = false;

  constructor(options: {
    config: Extract<HotCpuProfileConfig, { enabled: true }>;
    getAppMetrics: (reuseForMs: number) => AppMetricsSample | ProcessMetric[];
    session: HotCpuProfileSession;
    target: HotCpuTarget;
    logger?: Logger;
    now?: () => Date;
    onHeapSnapshotLimitReached?: () => void | Promise<void>;
    onProfileWritten?: (event: HotCpuProfileCapturedEvent) => void | Promise<void>;
    /** Begin companion capture at detection. Settle it after the CPU profile is saved or fails. */
    onProfileTriggered?: ProfileTriggerListener;
    onProfileFinished?: () => void;
    /**
     * Fires once per completed sampling iteration, after the sample has been
     * written and any profile it triggered has started.
     *
     * The loop is a self-rescheduling timer whose body awaits real disk
     * writes, so it publishes no progress an observer can wait on. Without
     * this, a test can only poll on a wall-clock budget and hope the machine
     * is fast enough — which is exactly how this suite flaked on loaded CI
     * while passing locally. Unused in production.
     */
    onSampleCaptured?: () => void;
  }) {
    this.config = options.config;
    this.getAppMetrics = options.getAppMetrics;
    this.logger = options.logger ?? getDiagLogger("pwrgit:hot-cpu");
    this.now = options.now ?? (() => new Date());
    this.onHeapSnapshotLimitReached = options.onHeapSnapshotLimitReached;
    this.onProfileWritten = options.onProfileWritten;
    this.onProfileTriggered = options.onProfileTriggered;
    this.onProfileFinished = options.onProfileFinished;
    this.onSampleCaptured = options.onSampleCaptured;
    this.session = options.session;
    this.target = options.target;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.startPromise ??= this.startInner();
    await this.startPromise;
  }

  private async startInner(): Promise<void> {
    const startedAt = this.now();
    await this.session.appendEvent({
      capturedAt: startedAt.toISOString(),
      type: "monitor-started",
      detail: {
        intervalMs: this.config.intervalMs,
        rules: this.config.rules,
        overrides: this.config.overrides,
        startDelayMs: this.config.startDelayMs,
        triggerMode: this.config.triggerMode,
        thresholdPercent: this.config.thresholdPercent,
        slowburnThresholdPercent: this.config.slowburnThresholdPercent,
        consecutiveSamples: this.config.consecutiveSamples,
        profileDurationMs: this.config.profileDurationMs,
        captureHeapSnapshot: this.config.captureHeapSnapshot,
        heapSnapshotLimit: this.config.heapSnapshotLimit,
        recordingWindowMs: this.recordingWindowMs(),
      },
    });
    await this.ensureRecording(startedAt.getTime());
    this.logger.info("monitoring started", {
      target: this.session.target ?? "renderer",
      sessionDirectory: this.session.directoryPath,
      startDelayMs: this.config.startDelayMs,
      triggerMode: this.config.triggerMode,
      thresholdPercent: this.config.thresholdPercent,
      slowburnThresholdPercent: this.config.slowburnThresholdPercent,
      profileDurationMs: this.config.profileDurationMs,
    });
    this.scheduleNextSample(this.config.startDelayMs);
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.stopped = true;
    this.shutdownPromise = this.stopInner(reason);
    await this.shutdownPromise;
  }

  canCaptureAnotherProfile(): boolean {
    return !this.stopped && this.config.rules.length > 0 &&
      this.profileCount < this.config.maxProfiles && !this.isTargetDestroyed();
  }

  reconfigureRules(config: Extract<HotCpuProfileConfig, { enabled: true }>): void {
    this.config = config;
    this.ruleRevision++;
    this.resetSamples();
    if (this.intervalTimer && !this.waitingForFirstSample) {
      clearTimeout(this.intervalTimer);
      this.scheduleNextSample();
    }
    // The current profile owns its original trigger and companion until both
    // settle. The next sample uses the new rules and a fresh baseline.
    void this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "capture-rules-changed",
      detail: { intervalMs: config.intervalMs, rules: config.rules, overrides: config.overrides },
    }).catch((error) => this.logger.error("could not record CPU rule change", error));
  }

  hasTriggeredProfile(): boolean {
    return this.activeProfileTrigger !== null;
  }

  private async stopInner(reason: string): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();

    // Stop an already-started profile in parallel with its owning sample so a
    // blocked heap snapshot cannot deadlock shutdown. Recheck after the sample
    // settles in case it crossed into profiling while shutdown was starting.
    const captureSamplePromise = this.captureSamplePromise;
    const activeProfileStop =
      this.profiling || this.stopProfilePromise
        ? this.stopProfile(reason)
        : null;
    await Promise.all([captureSamplePromise, activeProfileStop]);

    if (this.profiling || this.stopProfilePromise) {
      await this.stopProfile(reason);
    }

    // An armed recorder without a trigger is discarded, never published.
    await this.discardRecording();
    this.detachDebugger();
    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "monitor-stopped",
      detail: { reason },
    });
  }

  private scheduleNextSample(delayMs = this.config.intervalMs): void {
    if (this.stopped) {
      return;
    }

    this.intervalTimer = setTimeout(() => {
      const captureSamplePromise = this.captureSample();
      this.captureSamplePromise = captureSamplePromise;
      void captureSamplePromise.then(
        () => {
          if (this.captureSamplePromise === captureSamplePromise) {
            this.captureSamplePromise = null;
          }
        },
        (error) => {
          if (this.captureSamplePromise === captureSamplePromise) {
            this.captureSamplePromise = null;
          }
          this.logger.error("sample task failed", error);
        },
      );
    }, delayMs);
  }

  private async captureSample(): Promise<void> {
    this.intervalTimer = null;
    this.waitingForFirstSample = false;

    if (this.stopped || this.isTargetDestroyed()) {
      return;
    }

    const capturedAtDate = this.now();
    const capturedAt = capturedAtDate.toISOString();
    const capturedAtMs = capturedAtDate.getTime();
    const revision = this.ruleRevision;
    let nextTick: number | undefined;
    try {
      const pid = this.target.getOSProcessId();
      const cadenceMs = this.config.intervalMs;
      const read = this.getAppMetrics(Math.min(25, cadenceMs * 0.2));
      const capturedMonotonicMs = Array.isArray(read) ? performance.now() : read.atMs;
      if (!Array.isArray(read)) {
        // Time production metrics readers against one monotonic grid, so
        // windows opened at different times can use the same Electron poll.
        nextTick = (Math.floor((capturedMonotonicMs + Math.min(25, cadenceMs * 0.2)) / cadenceMs) + 1) * cadenceMs;
      }
      const metric = (Array.isArray(read) ? read : read.metrics).find((candidate) => candidate.pid === pid);
      if (!metric) {
        this.resetSamples();
        await this.session.appendEvent({
          capturedAt,
          type: "sample-skipped",
          detail: { reason: "metric-not-found", pid },
        });
        await this.maintainRecording(capturedAtMs);
        return;
      }

      const cpu = metric.cpu;
      const usableCounter = cpu.cumulativeCPUUsage !== undefined &&
        Number.isFinite(cpu.cumulativeCPUUsage) && cpu.cumulativeCPUUsage >= 0;
      const cumulativeSeconds = usableCounter ? cpu.cumulativeCPUUsage : undefined;
      const interval = this.measureInterval(
        { pid, createdAt: metric.creationTime, atMs: capturedMonotonicMs, cumulativeSeconds },
        cpu.percentCPUUsage, Array.isArray(read) ? this.baseline?.atMs : read.previousAtMs
      );
      const matches = interval ? this.matcher.sample(interval, this.config.rules, cadenceMs) : [];
      await this.session.appendSample({
        capturedAt,
        pid,
        cpuPercent: interval?.cpuPercent ?? null,
        ...this.target.readHeapUsage?.(),
        electronCpuPercent: cpu.percentCPUUsage,
        cumulativeCpuSeconds: cumulativeSeconds,
        cumulativeCpuDeltaSeconds: interval?.cpuDeltaSeconds,
        wallDeltaSeconds: interval ? interval.durationMs / 1000 : undefined,
        measurementSource: interval?.source,
        idleWakeupsPerSecond: cpu.idleWakeupsPerSecond,
        workingSetSize: metric.memory.workingSetSize,
        peakWorkingSetSize: metric.memory.peakWorkingSetSize,
        consecutiveHotSamples: this.matcher.count(this.config.triggerMode),
        ...(matches.length ? { matchedRules: matches } : {}),
      });

      const primary = matches[0];
      if (primary && revision === this.ruleRevision && this.shouldStartProfile(capturedMonotonicMs)) {
        await this.startProfile({
          capturedAt,
          capturedMonotonicMs,
          pid,
          trigger: {
            matchedRules: matches,
            triggerConsecutiveSamples: primary.sampleCount,
            triggerCpuPercent: primary.sampleCpuPercent,
            triggerMode: primary.id,
            triggerThresholdPercent: primary.thresholdPercent,
          },
        });
      } else {
        await this.maintainRecording(capturedAtMs);
      }
    } catch (error) {
      this.resetSamples();
      await this.session.appendEvent({
        capturedAt,
        type: "sample-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("sample failed", error);
    } finally {
      if (!this.profiling) {
        const delay = nextTick === undefined ? 0 : nextTick - performance.now();
        this.scheduleNextSample(revision === this.ruleRevision && delay > 0 ? delay : undefined);
      } else {
        this.samplingPausedForProfile = true;
      }
      this.onSampleCaptured?.();
    }
  }

  private resetSamples(): void {
    this.baseline = null;
    this.matcher.reset();
  }

  private measureInterval(
    current: CpuBaseline, electronPercent: number, electronPreviousAtMs: number | null | undefined
  ): (CpuInterval & { cpuDeltaSeconds?: number }) | undefined {
    const previous = this.baseline;
    this.baseline = current;
    if (previous && previous.pid === current.pid && previous.createdAt === current.createdAt) {
      const durationMs = current.atMs - previous.atMs;
      if (durationMs > 0 && durationMs <= this.config.intervalMs * 1.5) {
        if (previous.cumulativeSeconds !== undefined && current.cumulativeSeconds !== undefined) {
          const cpuDeltaSeconds = current.cumulativeSeconds - previous.cumulativeSeconds;
          if (cpuDeltaSeconds >= 0) {
            return { cpuPercent: cpuDeltaSeconds / durationMs * 100_000, durationMs,
              cpuDeltaSeconds, source: "cumulative-cpu" };
          }
        } else if (current.cumulativeSeconds === undefined && previous.cumulativeSeconds === undefined &&
          electronPreviousAtMs === previous.atMs && Number.isFinite(electronPercent) && electronPercent >= 0) {
          return { cpuPercent: electronPercent, durationMs, source: "electron-interval-estimate" };
        }
      }
    }
    this.matcher.reset();
    return undefined;
  }

  private shouldStartProfile(capturedAtMonotonicMs: number): boolean {
    return !this.profiling && this.canCaptureAnotherProfile() &&
      (this.lastProfileAtMonotonicMs === null ||
        capturedAtMonotonicMs - this.lastProfileAtMonotonicMs >= this.config.cooldownMs);
  }

  private recordingWindowMs(): number {
    return Math.max(
      RECORDING_WINDOW_MS,
      ...this.config.rules.map((rule) => rule.sampleCount * this.config.intervalMs),
    );
  }

  private async maintainRecording(startedAtMs: number): Promise<void> {
    if (!this.canCaptureAnotherProfile()) {
      if (this.recording && !this.stopped) {
        await this.discardRecording();
        this.detachDebugger();
      }
      return;
    }
    await this.ensureRecording(startedAtMs);
    if (
      this.recording
      && performance.now() - this.recordingStartedAtMonotonicMs >= this.recordingWindowMs()
    ) {
      await this.rotateRecording(startedAtMs);
    }
  }

  private async ensureRecording(startedAtMs: number): Promise<void> {
    if (!this.canCaptureAnotherProfile() || this.recording) return;
    if (this.target.debugger.isAttached()) return;
    try {
      this.target.debugger.attach(CHROME_DEBUGGER_PROTOCOL_VERSION);
      this.debuggerAttached = true;
      this.target.debugger.on("detach", this.detachListener);
      await this.target.debugger.sendCommand("Profiler.enable");
      if (this.stopped) return;
      await this.target.debugger.sendCommand("Profiler.start");
      this.recording = true;
      this.recordingStartedAtMs = startedAtMs;
      this.recordingStartedAtMonotonicMs = performance.now();
    } catch (error) {
      this.recording = false;
      this.previousRecording = null;
      this.detachDebugger();
      await this.session.appendEvent({
        capturedAt: new Date(startedAtMs).toISOString(),
        type: "recorder-start-failed",
        detail: { error: serializeError(error) },
      });
    }
  }

  private async finishRecording(): Promise<Profiler.Profile> {
    if (!this.recording) throw new Error("CPU recorder is not armed");
    const result = await this.target.debugger.sendCommand("Profiler.stop") as {
      profile: Profiler.Profile;
    };
    this.recording = false;
    return result.profile;
  }

  private async rotateRecording(startedAtMs: number): Promise<void> {
    try {
      this.previousRecording = await this.finishRecording();
      this.previousRecordingStartedAtMs = this.recordingStartedAtMs;
      this.previousRecordingStartedAtMonotonicMs = this.recordingStartedAtMonotonicMs;
      if (this.stopped) return;
      await this.target.debugger.sendCommand("Profiler.start");
      this.recording = true;
      this.recordingStartedAtMs = startedAtMs;
      this.recordingStartedAtMonotonicMs = performance.now();
    } catch (error) {
      this.recording = false;
      this.previousRecording = null;
      this.detachDebugger();
      throw error;
    }
  }

  private async discardRecording(): Promise<void> {
    try {
      if (this.recording && !this.isTargetDestroyed()) await this.finishRecording();
    } catch (error) {
      this.logger.warn("recorder cleanup failed", error);
    } finally {
      this.recording = false;
      this.previousRecording = null;
    }
  }

  private async startProfile(options: {
    capturedAt: string;
    capturedMonotonicMs: number;
    pid: number;
    trigger: ActiveProfileTrigger;
  }): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (!this.recording) {
      // A debugger conflict may have prevented arming. Do not describe a
      // newly started recording as if it had captured this hot interval.
      await this.session.appendEvent({
        capturedAt: options.capturedAt,
        type: "profile-skipped",
        detail: {
          reason: !this.isTargetDestroyed() && this.target.debugger.isAttached()
            ? "debugger-already-attached"
            : "recorder-not-armed",
          cpuPercent: options.trigger.triggerCpuPercent,
          matchedRules: options.trigger.matchedRules,
          pid: options.pid,
        },
      });
      await this.ensureRecording(Date.parse(options.capturedAt));
      return;
    }

    try {
      this.profiling = true;
      if (this.stopped) {
        return;
      }
      this.activeProfileHeapSnapshots = [];
      this.activeProfileTrigger = options.trigger;
      this.profileCount += 1;
      const index = this.profileCount;
      this.lastProfileAtMonotonicMs = options.capturedMonotonicMs;
      try {
        this.profileCompanion = this.onProfileTriggered?.(
          this.session.createProfilePath(index), Date.parse(options.capturedAt), options.capturedMonotonicMs
        );
      } catch (error) {
        this.logger.warn("CPU profile companion capture failed to start", error);
      }
      await this.session.appendEvent({
        capturedAt: options.capturedAt,
        type: "profile-started",
        detail: {
          index,
          cpuPercent: options.trigger.triggerCpuPercent,
          ...options.trigger,
          pid: options.pid,
          durationMs: this.config.profileDurationMs,
          recordingStartedAt: new Date(this.previousRecording
            ? this.previousRecordingStartedAtMs
            : this.recordingStartedAtMs).toISOString(),
          preTriggerDurationMs: options.capturedMonotonicMs - (this.previousRecording
            ? this.previousRecordingStartedAtMonotonicMs
            : this.recordingStartedAtMonotonicMs),
        },
      });
      this.logger.warn("CPU profile started", {
        cpuPercent: options.trigger.triggerCpuPercent,
        matchedRules: options.trigger.matchedRules,
        pid: options.pid,
        target: this.session.target ?? "renderer",
        sessionDirectory: this.session.directoryPath,
      });

      if (this.config.captureHeapSnapshot && this.target.takeHeapSnapshot) {
        await this.captureHeapSnapshot(index, "start");
        if (this.stopped || !this.profiling) {
          return;
        }
        this.scheduleMidProfileHeapSnapshot(index);
      }

      if (this.stopped || !this.profiling) {
        return;
      }
      this.profileDurationTimer = setTimeout(
        () => this.stopProfile("duration-elapsed"),
        this.config.profileDurationMs,
      );
    } catch (error) {
      this.activeProfileTrigger = null;
      this.profiling = false;
      await this.finishProfileCompanion(false);
      this.onProfileFinished?.();
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-start-failed",
        detail: { error: serializeError(error) },
      });
      this.logger.error("CPU profile failed to start", error);
      await this.discardRecording();
      this.detachDebugger();
    }
  }

  private async stopProfile(reason: string): Promise<void> {
    if (this.stopProfilePromise) {
      await this.stopProfilePromise;
      return;
    }

    if (!this.profiling) {
      return;
    }

    this.stopProfilePromise = this.stopProfileInner(reason);
    try {
      await this.stopProfilePromise;
    } finally {
      this.stopProfilePromise = null;
    }
  }

  private async stopProfileInner(reason: string): Promise<void> {
    this.profiling = false;
    this.clearProfileDurationTimer();
    this.clearHeapSnapshotMidTimer();
    const index = this.profileCount;
    const profilePath = this.session.createProfilePath(index);
    const profileFilename = artifactFilename(profilePath);
    const activeProfileTrigger = this.activeProfileTrigger;
    let companionFinished: Promise<void> | undefined;
    try {
      if (!activeProfileTrigger) throw new Error("CPU profile has no trigger");
      const current = await this.finishRecording();
      const profile = joinCpuProfiles(this.previousRecording
        ? [this.previousRecording, current]
        : [current]);
      await fs.writeFile(
        profilePath,
        `${JSON.stringify(profile)}\n`,
        "utf8",
      );
      await this.session.registerArtifact(profileFilename);
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-written",
        detail: {
          filename: profileFilename,
          reason,
        },
      });

      // Authorize the trace once the CPU profile is saved. Optional snapshots
      // and the notice can finish while the native export or worker is pending.
      companionFinished = this.finishProfileCompanion(true);

      if (
        !this.stopped &&
        this.config.captureHeapSnapshot &&
        this.target.takeHeapSnapshot
      ) {
        await this.drainActiveHeapSnapshotCaptures();
        await this.captureHeapSnapshot(index, "stop");
      }
      await this.drainActiveHeapSnapshotCaptures();
      await this.onProfileWritten?.({
        capturedAt: this.now().toISOString(),
        heapSnapshotArtifacts: [...this.activeProfileHeapSnapshots],
        profileFilename,
        profilePath,
        target: this.session.target ?? "renderer",
        sessionDirectory: this.session.directoryPath,
        sessionDirectoryName: this.session.directoryName,
        ...activeProfileTrigger,
      });
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "profile-stop-failed",
        detail: {
          filename: profileFilename,
          reason,
          error: serializeError(error),
        },
      });
      this.logger.error("CPU profile failed to stop", error);
    } finally {
      // Keep the trigger eligible until the companion settles.
      await (companionFinished ?? this.finishProfileCompanion(false));
      this.activeProfileTrigger = null;
      this.activeProfileHeapSnapshots = [];
      this.activeProfileHeapSnapshotCaptures.clear();
      this.previousRecording = null;
      this.recording = false;
      this.detachDebugger();
      await this.ensureRecording(this.now().getTime());
      this.resumeSamplingAfterProfile();
      this.onProfileFinished?.();
    }
  }

  private async finishProfileCompanion(profileWritten: boolean): Promise<void> {
    const companion = this.profileCompanion;
    this.profileCompanion = undefined;
    try {
      await companion?.(profileWritten);
    } catch (error) {
      this.logger.warn("CPU profile companion artifact failed", error);
    }
  }

  private resumeSamplingAfterProfile(): void {
    if (!this.samplingPausedForProfile) {
      return;
    }

    this.samplingPausedForProfile = false;
    this.resetSamples();
    if (this.stopped || this.intervalTimer || this.isTargetDestroyed()) {
      return;
    }

    this.scheduleNextSample();
  }

  private async captureHeapSnapshot(index: number, phase: string): Promise<void> {
    const capture = this.writeHeapSnapshot(index, phase);
    if (index === this.profileCount) {
      this.activeProfileHeapSnapshotCaptures.add(capture);
    }

    try {
      await capture;
    } finally {
      this.activeProfileHeapSnapshotCaptures.delete(capture);
    }
  }

  private async writeHeapSnapshot(index: number, phase: string): Promise<void> {
    if (!this.target.takeHeapSnapshot) {
      return;
    }

    if (this.heapSnapshotsCaptured >= this.config.heapSnapshotLimit) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-skipped",
        detail: {
          index,
          phase,
          reason: "limit-reached",
          limit: this.config.heapSnapshotLimit,
        },
      });
      await this.notifyHeapSnapshotLimitReached();
      return;
    }

    const snapshotNumber = this.heapSnapshotsCaptured + 1;
    this.heapSnapshotsCaptured = snapshotNumber;
    const snapshotPath = this.session.createHeapSnapshotPath(index, phase);
    const snapshotFilename = artifactFilename(snapshotPath);
    try {
      await this.target.takeHeapSnapshot(snapshotPath);
      await this.session.registerArtifact(snapshotFilename);
      if (index === this.profileCount) {
        this.activeProfileHeapSnapshots.push({
          filename: snapshotFilename,
          path: snapshotPath,
          phase,
        });
      }
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-written",
        detail: {
          filename: snapshotFilename,
          index,
          phase,
          snapshotNumber,
          limit: this.config.heapSnapshotLimit,
        },
      });
    } catch (error) {
      await this.session.appendEvent({
        capturedAt: this.now().toISOString(),
        type: "heap-snapshot-failed",
        detail: {
          filename: snapshotFilename,
          index,
          phase,
          snapshotNumber,
          limit: this.config.heapSnapshotLimit,
          error: serializeError(error),
        },
      });
      this.logger.error("heap snapshot failed", error);
    } finally {
      if (this.heapSnapshotsCaptured >= this.config.heapSnapshotLimit) {
        await this.notifyHeapSnapshotLimitReached();
      }
    }
  }

  private async drainActiveHeapSnapshotCaptures(): Promise<void> {
    while (this.activeProfileHeapSnapshotCaptures.size > 0) {
      await Promise.all([...this.activeProfileHeapSnapshotCaptures]);
    }
  }

  private scheduleMidProfileHeapSnapshot(index: number): void {
    if (
      !this.config.captureHeapSnapshot ||
      !this.target.takeHeapSnapshot ||
      this.config.heapSnapshotLimit < 3 ||
      this.heapSnapshotLimitReached
    ) {
      return;
    }

    this.clearHeapSnapshotMidTimer();
    this.heapSnapshotMidTimer = setTimeout(() => {
      this.heapSnapshotMidTimer = null;
      void this.captureHeapSnapshot(index, "mid");
    }, Math.max(1, Math.floor(this.config.profileDurationMs / 2)));
  }

  private async notifyHeapSnapshotLimitReached(): Promise<void> {
    if (this.heapSnapshotLimitReached) {
      return;
    }

    this.heapSnapshotLimitReached = true;
    await this.session.appendEvent({
      capturedAt: this.now().toISOString(),
      type: "heap-snapshot-limit-reached",
      detail: {
        captured: this.heapSnapshotsCaptured,
        limit: this.config.heapSnapshotLimit,
      },
    });

    try {
      await this.onHeapSnapshotLimitReached?.();
    } catch (error) {
      this.logger.warn("heap snapshot auto-disable failed", {
        error: serializeError(error),
        target: this.session.target ?? "renderer",
        sessionDirectory: this.session.directoryPath,
      });
    }
  }

  private detachDebugger(): void {
    if (this.isTargetDestroyed()) {
      this.debuggerAttached = false;
      return;
    }

    try {
      if (this.target.debugger.off) {
        this.target.debugger.off("detach", this.detachListener);
      }

      if (!this.debuggerAttached || !this.target.debugger.isAttached()) {
        return;
      }

      this.target.debugger.detach();
      this.debuggerAttached = false;
    } catch (error) {
      this.debuggerAttached = false;
      this.logger.warn("target debugger detach failed", {
        error: serializeError(error),
        target: this.session.target ?? "renderer",
        sessionDirectory: this.session.directoryPath,
      });
    }
  }

  private isTargetDestroyed(): boolean {
    return Boolean(this.target.isDestroyed?.());
  }

  private clearProfileDurationTimer(): void {
    if (!this.profileDurationTimer) {
      return;
    }

    clearTimeout(this.profileDurationTimer);
    this.profileDurationTimer = null;
  }

  private clearHeapSnapshotMidTimer(): void {
    if (!this.heapSnapshotMidTimer) {
      return;
    }

    clearTimeout(this.heapSnapshotMidTimer);
    this.heapSnapshotMidTimer = null;
  }
}
