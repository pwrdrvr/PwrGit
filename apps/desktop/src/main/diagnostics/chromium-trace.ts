import { addAbortListener } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ContentTracing, TraceConfig } from "electron";

const TRACE_CATEGORIES = ["devtools.timeline", "blink.user_timing", "cc", "viz"];
// A full 32 MiB rolling buffer has exported 141,316,964 bytes on Electron
// 44.10.2. Allow at least twice that decoded size without resizing the ring.
const MAX_RAW_TRACE_BYTES = 288 * 1024 * 1024;
const START_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 4_000;
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

type ChromiumTraceCapture =
  | { status: "written"; recordingStartedAtMs: number; recordingStoppedAtMs: number; rawBytes: number; rawLimitBytes: number }
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" | "canceled" };

type TraceOptions = {
  wallNow?: () => number;
  monotonicNow?: () => number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  filterTimeoutMs?: number;
  filterTrace?: (rawPath: string, filteredPath: string) => Promise<void>;
  workerModule?: string | URL | undefined;
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
  private pendingCapture: { controller: AbortController; done: Promise<ChromiumTraceCapture> } | null = null;
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
    return this.enqueue(async () => {
      if (armed && (this.recording !== null || this.pendingCapture !== null)) return;
      const pending = this.pendingCapture;
      if (pending !== null) {
        pending.controller.abort(TRACE_DISARMED);
        await pending.done.catch(() => undefined);
      }
      if (this.nativeMayBeRecording) await this.discard();
      if (armed && !this.nativeMayBeRecording) await this.start();
    });
  }

  /** Stop the rolling trace at detection. Give the CPU profiler its full
   * follow-up before spending CPU on JSON filtering or publishing a companion. */
  capture(
    filePath: string,
    triggerMonotonicMs: number,
    canPublish: () => boolean | Promise<boolean> = () => true,
    profileDurationMs = 0
  ): Promise<ChromiumTraceCapture> {
    const capture: Promise<ChromiumTraceCapture> = this.enqueue(async () => {
      const recording = this.recording;
      if (recording === null) return { status: "skipped", reason: "not-recording" } as const;
      if (triggerMonotonicMs <= recording.monotonicMs) {
        return { status: "skipped", reason: "trigger-predates-recording" } as const;
      }

      // Keep one scratch export. Once the native stop releases the queue,
      // disarming can cancel either the profile wait or the worker.
      const controller = new AbortController();
      this.pendingCapture = { controller, done: capture };
      const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
      const recordingStoppedAtMs = this.options.wallNow?.() ?? Date.now();
      return { recording, recordingStoppedAtMs, signal, ...await this.freeze() };
    }).then(async (frozen): Promise<ChromiumTraceCapture> => {
      if (frozen.status === "skipped") return frozen;
      const { signal } = frozen;
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
        await this.publish(frozen.rawPath, filePath, budget, signal);
        return {
          status: "written", recordingStartedAtMs: frozen.recording.wallMs,
          recordingStoppedAtMs: frozen.recordingStoppedAtMs, rawBytes, rawLimitBytes: MAX_RAW_TRACE_BYTES
        };
      } catch (error) {
        if (error === TRACE_DISARMED) return { status: "skipped", reason: "canceled" };
        throw error;
      } finally {
        await frozen.cleanup();
      }
    }).finally(() => {
      if (this.pendingCapture?.done === capture) this.pendingCapture = null;
    });
    return capture;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
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
      const frozen = await this.freeze();
      await frozen.cleanup();
    } catch (error) {
      if (error instanceof Error && error.message === "Failed to stop tracing - no trace in progress") {
        this.nativeMayBeRecording = false;
      } else {
        this.warn("Could not discard Chromium trace", error);
      }
    }
  }

  private async publish(rawPath: string, filePath: string, budget: string, signal: AbortSignal): Promise<void> {
    // Stage the filtered file on the destination filesystem so it becomes
    // visible under the artifact name only after the entire export succeeds.
    let staging: string | undefined;
    try {
      signal.throwIfAborted();
      staging = await fs.mkdtemp(path.join(path.dirname(filePath), ".pwrgit-trace-"));
      const filteredPath = path.join(staging, "filtered.json");
      if (this.options.filterTrace) await this.options.filterTrace(rawPath, filteredPath);
      else await this.filterInWorker(rawPath, filteredPath, signal);
      signal.throwIfAborted();
      await fs.rename(filteredPath, filePath);
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

  private async filterInWorker(rawPath: string, filteredPath: string, signal: AbortSignal): Promise<void> {
    const module = this.options.workerModule ?? new URL("./chromium-trace-worker.ts", import.meta.url);
    // Packaged workers live inside app.asar. Resolve the standalone ESM
    // asset with Electron's filesystem before starting Node's loader.
    const entry = typeof module === "string"
      ? new URL(`data:text/javascript;base64,${await fs.readFile(module, "base64")}`)
      : module;
    signal.throwIfAborted();
    const worker = new Worker(entry, {
      workerData: { rawPath, filteredPath, allowedCategories: TRACE_CATEGORIES },
      resourceLimits: { maxOldGenerationSizeMb: 96 }
    });
    try {
      await withDeadline(new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Chromium trace filter exited with code ${code}`));
        });
      }), this.options.filterTimeoutMs ?? FILTER_TIMEOUT_MS, "Filtering Chromium trace", signal);
    } finally {
      await worker.terminate();
    }
  }

  private async freeze(): Promise<{ rawPath: string; cleanup: () => Promise<void> }> {
    this.recording = null;
    // The native endpoint writes its temporary file beside the destination.
    // Keep both outside the published capture directory, even on a late flush.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pwrgit-chromium-trace-"));
    const rawPath = path.join(scratch, "trace.json");
    const cleanup = () => fs.rm(scratch, { recursive: true, force: true }).catch((error) => {
      this.warn("Could not remove private trace staging directory", error);
    });
    try {
      this.shutdown.signal.throwIfAborted();
      await withDeadline(this.backend().stopRecording(rawPath),
        this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS, "Stopping Chromium trace", this.shutdown.signal);
      this.nativeMayBeRecording = false;
      return { rawPath, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}
