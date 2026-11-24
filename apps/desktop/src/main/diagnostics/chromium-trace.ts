import { addAbortListener } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { utilityProcess, type ContentTracing, type TraceConfig } from "electron";
import type { ChromiumTraceFilterResult } from "./chromium-trace-worker";

const TRACE_CATEGORIES = ["devtools.timeline", "blink.user_timing", "cc", "viz"];
// A full 32 MiB rolling buffer has exported 141,316,964 bytes on Electron
// 44.10.2. Allow at least twice that decoded size without resizing the ring.
const MAX_RAW_TRACE_BYTES = 288 * 1024 * 1024;
const START_TIMEOUT_MS = 1_000;
// The pinned Electron oracle took about 4.6 seconds with a full ring and a
// busy browser process. Allow twice that time for a capture, with a shorter
// bound for discard and the separate quit drain deadline.
const CAPTURE_STOP_TIMEOUT_MS = 10_000;
const DISCARD_STOP_TIMEOUT_MS = 4_000;
// Allow the configured CPU follow-up plus time for snapshots and profile I/O.
const PROFILE_SETTLEMENT_GRACE_MS = 15_000;
// Full-size exports exceeded five seconds on both Linux and Windows CI.
const FILTER_TIMEOUT_MS = 15_000;
const TRACE_DISARMED = new Error("Chromium tracing was disabled");

// Electron 44 types call this recording_mode, but the object is passed through
// to Chromium's TraceConfig dictionary parser, which reads record_mode.
type ChromiumTraceConfig = Omit<TraceConfig, "recording_mode"> & {
  record_mode: "record-continuously";
};

type TraceBackend = Pick<ContentTracing, "stopRecording"> & {
  startRecording: (config: ChromiumTraceConfig) => Promise<void>;
};

type NativeStopTiming = {
  recordingStoppedAtMs: number;
  nativeStopElapsedMs: number;
  nativeStopTimeoutMs: number;
};

type ChromiumTraceCapture =
  | (NativeStopTiming & {
    status: "written"; recordingStartedAtMs: number; rawBytes: number; rawLimitBytes: number;
    filterElapsedMs: number; filterCpuMs?: number;
  })
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" | "canceled" };

export class ChromiumTraceStopError extends Error {
  constructor(cause: unknown, readonly timing: NativeStopTiming) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

type TraceOptions = {
  wallNow?: () => number;
  monotonicNow?: () => number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  filterTimeoutMs?: number;
  filterTrace?: (rawPath: string, filteredPath: string) => Promise<void>;
  workerModule?: string | undefined;
};

async function withDeadline<T>(
  operation: Promise<T>, timeoutMs: number, description: string, signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        if (signal) onAbort = addAbortListener(signal, () => reject(signal.reason));
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    onAbort?.[Symbol.dispose]();
    clearTimeout(timer);
  }
}

/** Chromium allows a single trace for the app, even with multiple profile
 * windows. An overlapping CPU trigger cannot claim the next trace's history. */
export class ChromiumTrace {
  private queue: Promise<unknown> = Promise.resolve();
  private recording: { wallMs: number; monotonicMs: number } | null = null;
  private pendingCapture: Promise<ChromiumTraceCapture> | null = null;
  private abandonedCleanup: Promise<void> | null = null;
  private armedRequested = false;
  private disarm = new AbortController();
  private readonly shutdown = new AbortController();
  private shutdownDeadlineMs = Infinity;
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  // A native promise may never settle. After a timeout, stop and discard any
  // unconfirmed native recording before accepting another trigger.
  private nativeMayBeRecording = false;

  constructor(
    private readonly backend: () => TraceBackend,
    private readonly warn: (message: string, error: unknown) => void,
    private readonly options: TraceOptions = {}
  ) {}

  /** Reserve time for cleanup when the app starts or hurries its quit drain. */
  beginShutdown(budgetMs: number): void {
    const deadline = performance.now() + budgetMs;
    if (deadline >= this.shutdownDeadlineMs) return;
    this.shutdownDeadlineMs = deadline;
    this.clearShutdownTimer();
    const abort = () => this.shutdown.abort(new Error("Chromium trace timed out during shutdown"));
    if (budgetMs <= 0) abort();
    else this.shutdownTimer = setTimeout(abort, budgetMs).unref();
  }

  clearShutdownTimer(): void {
    clearTimeout(this.shutdownTimer);
  }

  setArmed(armed: boolean): Promise<void> {
    this.armedRequested = armed;
    if (!armed) {
      this.disarm.abort(TRACE_DISARMED);
      this.disarm = new AbortController();
    }
    return this.enqueue(() => this.reconcileArmed(armed));
  }

  /** Stop the rolling trace at detection. Give the CPU profiler its full
   * follow-up before spending CPU on JSON filtering or publishing a companion. */
  capture(
    filePath: string,
    triggerMonotonicMs: number,
    canPublish: () => boolean | Promise<boolean> = () => true,
    profileDurationMs = 0
  ): Promise<ChromiumTraceCapture> {
    const signal = AbortSignal.any([this.disarm.signal, this.shutdown.signal]);
    const capture: Promise<ChromiumTraceCapture> = this.enqueue(async () => {
      const recording = this.recording;
      if (recording === null) return { status: "skipped", reason: "not-recording" } as const;
      if (triggerMonotonicMs <= recording.monotonicMs) {
        return { status: "skipped", reason: "trigger-predates-recording" } as const;
      }

      // Keep one scratch export across the native stop, profile wait and worker.
      this.pendingCapture = capture;
      const frozen = await this.freeze(this.options.stopTimeoutMs ?? CAPTURE_STOP_TIMEOUT_MS, signal);
      return { recording, ...frozen };
    }).then(async (frozen): Promise<ChromiumTraceCapture> => {
      if (frozen.status === "skipped") return frozen;
      try {
        signal.throwIfAborted();
        const { size: rawBytes } = await fs.stat(frozen.rawPath);
        const budget = `${rawBytes} raw bytes, ${MAX_RAW_TRACE_BYTES} byte limit`;
        if (rawBytes > MAX_RAW_TRACE_BYTES) {
          throw new Error(`Chromium trace exceeded the export size limit (${budget})`);
        }
        const profileWaitMs = Math.min(profileDurationMs + PROFILE_SETTLEMENT_GRACE_MS, 2_147_483_647);
        const publish = await withDeadline(Promise.resolve(canPublish()), profileWaitMs, "Waiting for CPU profile", signal);
        if (!publish) return { status: "skipped", reason: "canceled" };
        const filter = await this.publish(frozen.rawPath, filePath, budget, signal);
        return {
          status: "written", recordingStartedAtMs: frozen.recording.wallMs,
          ...frozen.timing, rawBytes, rawLimitBytes: MAX_RAW_TRACE_BYTES, ...filter
        };
      } finally {
        await frozen.cleanup();
      }
    }).catch((error: unknown) => {
      if (error === TRACE_DISARMED) return { status: "skipped", reason: "canceled" } as const;
      throw error;
    }).finally(() => {
      if (this.pendingCapture === capture) this.pendingCapture = null;
    });
    return capture;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async reconcileArmed(armed: boolean): Promise<void> {
    if (armed && (this.shutdownDeadlineMs !== Infinity || this.recording !== null || this.pendingCapture !== null)) return;
    if (this.pendingCapture !== null) await this.pendingCapture.catch(() => undefined);
    if (this.abandonedCleanup !== null) {
      if (this.shutdownDeadlineMs === Infinity) return;
      await this.abandonedCleanup;
    }
    if (this.nativeMayBeRecording) await this.discard();
    if (armed && this.shutdownDeadlineMs === Infinity && !this.nativeMayBeRecording) await this.start();
  }

  private async start(): Promise<void> {
    try {
      this.nativeMayBeRecording = true;
      await withDeadline(this.backend().startRecording({
        record_mode: "record-continuously",
        trace_buffer_size_in_kb: 32 * 1024,
        included_categories: [...TRACE_CATEGORIES],
        excluded_categories: ["*"]
      }), this.options.startTimeoutMs ?? START_TIMEOUT_MS, "Starting Chromium trace");
      this.recording = {
        wallMs: this.options.wallNow?.() ?? Date.now(),
        monotonicMs: this.options.monotonicNow?.() ?? performance.now()
      };
    } catch (error) {
      this.warn("Could not arm Chromium trace", error);
    }
  }

  private async discard(): Promise<void> {
    try {
      const frozen = await this.freeze(this.options.stopTimeoutMs ?? DISCARD_STOP_TIMEOUT_MS, this.shutdown.signal);
      await frozen.cleanup();
    } catch (error) {
      if (error instanceof Error && error.message === "Failed to stop tracing - no trace in progress") {
        this.nativeMayBeRecording = false;
      } else {
        this.warn("Could not discard Chromium trace", error);
      }
    }
  }

  private async publish(rawPath: string, filePath: string, budget: string, signal: AbortSignal): Promise<{
    filterElapsedMs: number; filterCpuMs?: number;
  }> {
    // Stage the filtered file on the destination filesystem so it becomes
    // visible under the artifact name only after the entire export succeeds.
    let staging: string | undefined;
    try {
      signal.throwIfAborted();
      staging = await fs.mkdtemp(path.join(path.dirname(filePath), ".pwrgit-trace-"));
      const filteredPath = path.join(staging, "filtered.json");
      const started = performance.now();
      const filterCpuMs = this.options.filterTrace
        ? await this.options.filterTrace(rawPath, filteredPath)
        : await this.filterInUtilityProcess(rawPath, filteredPath, signal);
      const filterElapsedMs = performance.now() - started;
      signal.throwIfAborted();
      await fs.rename(filteredPath, filePath);
      return { filterElapsedMs, ...(filterCpuMs !== undefined && { filterCpuMs }) };
    } catch (error) {
      if (signal.reason === TRACE_DISARMED) throw TRACE_DISARMED;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (${budget})`);
    } finally {
      if (staging !== undefined) {
        await fs.rm(staging, { recursive: true, force: true }).catch((error) => {
          this.warn("Could not remove filtered trace staging directory", error);
        });
      }
    }
  }

  private async filterInUtilityProcess(rawPath: string, filteredPath: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    if (typeof utilityProcess?.fork !== "function") throw new Error("Isolated Chromium trace filtering is unavailable");
    const entry = this.options.workerModule ?? fileURLToPath(new URL("./chromium-trace-worker.ts", import.meta.url));
    const child = utilityProcess.fork(entry, [rawPath, filteredPath, ...TRACE_CATEGORIES], {
      serviceName: "PwrGit Chromium trace filter", stdio: "ignore"
    });
    let result: ChromiumTraceFilterResult | undefined;
    child.once("message", (message: ChromiumTraceFilterResult) => { result = message; });
    // Fatal V8 reports are followed by exit. Keep report contents out of logs.
    child.on("error", () => {});
    let exited = false;
    const exit = new Promise<number>((resolve) => child.once("exit", (code) => {
      exited = true;
      resolve(code);
    }));
    try {
      const code = await withDeadline(exit, this.options.filterTimeoutMs ?? FILTER_TIMEOUT_MS, "Filtering Chromium trace", signal);
      if (result && "error" in result) throw new Error(result.error);
      if (code !== 0 || !result) throw new Error(`Chromium trace filter failed (exit code ${code})`);
      return result.cpuMs;
    } finally {
      if (!exited) {
        // An early abort can arrive before Electron has a PID to kill. Wait
        // for exit before removing scratch files, including on Windows.
        if (child.pid === undefined) child.once("spawn", () => child.kill());
        else child.kill();
        await exit;
      }
    }
  }

  private async freeze(timeoutMs: number, signal: AbortSignal): Promise<{
    rawPath: string; cleanup: () => Promise<void>; timing: NativeStopTiming
  }> {
    this.recording = null;
    signal.throwIfAborted();
    // The native endpoint writes its temporary file beside the destination.
    // Keep both outside the published capture directory, even on a late flush.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pwrgit-chromium-trace-"));
    const rawPath = path.join(scratch, "trace.json");
    const cleanup = () => fs.rm(scratch, { recursive: true, force: true }).catch((error) => {
      this.warn("Could not remove private trace staging directory", error);
    });
    let nativeStop: Promise<string> | undefined;
    let nativeSettled = false;
    let startedAt = 0;
    try {
      signal.throwIfAborted();
      const recordingStoppedAtMs = this.options.wallNow?.() ?? Date.now();
      startedAt = performance.now();
      const timing = (): NativeStopTiming => ({
        recordingStoppedAtMs,
        nativeStopElapsedMs: Math.round(performance.now() - startedAt),
        nativeStopTimeoutMs: timeoutMs
      });
      try {
        nativeStop = this.backend().stopRecording(rawPath).finally(() => { nativeSettled = true; });
        await withDeadline(nativeStop, timeoutMs, "Stopping Chromium trace", signal);
      } catch (error) {
        if (error === TRACE_DISARMED) throw error;
        throw new ChromiumTraceStopError(error, timing());
      }
      this.nativeMayBeRecording = false;
      return { rawPath, cleanup, timing: timing() };
    } catch (error) {
      if (nativeStop && !nativeSettled) {
        const remainingMs = error === TRACE_DISARMED ? timeoutMs - (performance.now() - startedAt) : 0;
        const done = this.cleanAbandonedStop(nativeStop, () => nativeSettled, remainingMs, cleanup);
        if (error !== TRACE_DISARMED) await done;
      } else {
        await cleanup();
      }
      throw error;
    }
  }

  private cleanAbandonedStop(
    nativeStop: Promise<string>, nativeSettled: () => boolean, remainingMs: number, cleanup: () => Promise<void>
  ): Promise<void> {
    const rearmIfRequested = () => this.enqueue(async () => {
      if (this.armedRequested) await this.reconcileArmed(true);
    });
    let removedDuringDrain = false;
    const removeScratch = () => {
      removedDuringDrain = !nativeSettled();
      return cleanup();
    };
    // Keep the path usable through the original stop deadline. Unlinking
    // Chromium's temp file mid-drain can prevent its final rename and callback.
    const done = remainingMs > 0
      ? withDeadline(nativeStop, remainingMs, "Draining canceled Chromium trace", this.shutdown.signal)
        .catch(() => undefined).then(removeScratch)
      : removeScratch();
    this.abandonedCleanup = done;
    void done.then(() => {
      this.abandonedCleanup = null;
      if (remainingMs > 0) return rearmIfRequested();
    }).catch((error) => this.warn("Could not finish canceled Chromium trace", error));
    // Windows may have refused deletion while the native writer held the file.
    void nativeStop.catch(() => undefined).then(async () => {
      await done;
      if (!removedDuringDrain) return;
      await cleanup();
      await rearmIfRequested();
    }).catch((error) => this.warn("Could not settle abandoned Chromium trace", error));
    return done;
  }
}
