import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ContentTracing, TraceConfig } from "electron";

const TRACE_CATEGORIES = ["devtools.timeline", "blink.user_timing", "cc", "viz"];
// Full 32 MiB rolling buffers exported up to 125,198,470 bytes on Electron
// 44.10.2. Keep more than twice that decoded size within the export budget.
const MAX_RAW_TRACE_BYTES = 256 * 1024 * 1024;
const START_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 4_000;
const FILTER_TIMEOUT_MS = 5_000;

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
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" };

type TraceOptions = {
  wallNow?: () => number;
  monotonicNow?: () => number;
  bufferSizeKb?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  filterTimeoutMs?: number;
  filterTrace?: (rawPath: string, filteredPath: string) => Promise<void>;
  workerModule?: string | URL | undefined;
};

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Chromium allows a single trace for the app, even with multiple profile
 * windows. An overlapping CPU trigger cannot claim the next trace's history. */
export class ChromiumTrace {
  private queue: Promise<unknown> = Promise.resolve();
  private recording: { wallMs: number; monotonicMs: number } | null = null;
  // A native promise may never settle. After a timeout, stop and discard any
  // unconfirmed native recording before accepting another trigger.
  private nativeMayBeRecording = false;

  constructor(
    private readonly backend: () => TraceBackend,
    private readonly warn: (message: string, error: unknown) => void,
    private readonly options: TraceOptions = {}
  ) {}

  setArmed(armed: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (armed && this.recording !== null) return;
      if (this.nativeMayBeRecording) await this.discard();
      if (armed && !this.nativeMayBeRecording) await this.start();
    });
  }

  capture(filePath: string, triggerMonotonicMs: number): Promise<ChromiumTraceCapture> {
    return this.enqueue(async () => {
      const recording = this.recording;
      if (recording === null) return { status: "skipped", reason: "not-recording" };
      if (triggerMonotonicMs <= recording.monotonicMs) {
        return { status: "skipped", reason: "trigger-predates-recording" };
      }
      const recordingStoppedAtMs = this.options.wallNow?.() ?? Date.now();
      const rawBytes = await this.stop((rawPath) => this.publish(rawPath, filePath));
      return {
        status: "written", recordingStartedAtMs: recording.wallMs, recordingStoppedAtMs,
        rawBytes, rawLimitBytes: MAX_RAW_TRACE_BYTES
      };
    });
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
        trace_buffer_size_in_kb: this.options.bufferSizeKb ?? 32 * 1024,
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
      await this.stop();
    } catch (error) {
      if (error instanceof Error && error.message === "Failed to stop tracing - no trace in progress") {
        this.nativeMayBeRecording = false;
      } else {
        this.warn("Could not discard Chromium trace", error);
      }
    }
  }

  private async publish(rawPath: string, filePath: string): Promise<number> {
    const { size: rawBytes } = await fs.stat(rawPath);
    const budget = `${rawBytes} raw bytes, ${MAX_RAW_TRACE_BYTES} byte limit`;
    if (rawBytes > MAX_RAW_TRACE_BYTES) {
      throw new Error(`Chromium trace exceeded the export size limit (${budget})`);
    }

    // Stage the filtered file on the destination filesystem so it becomes
    // visible under the artifact name only after the entire export succeeds.
    let staging: string | undefined;
    try {
      staging = await fs.mkdtemp(path.join(path.dirname(filePath), ".pwrgit-trace-"));
      const filteredPath = path.join(staging, "filtered.json");
      if (this.options.filterTrace) await this.options.filterTrace(rawPath, filteredPath);
      else await this.filterInWorker(rawPath, filteredPath);
      await fs.rename(filteredPath, filePath);
      return rawBytes;
    } catch (error) {
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

  private async filterInWorker(rawPath: string, filteredPath: string): Promise<void> {
    const module = this.options.workerModule ?? new URL("./chromium-trace-worker.ts", import.meta.url);
    // Packaged workers live inside app.asar. Resolve the standalone ESM
    // asset with Electron's filesystem before starting Node's loader.
    const entry = typeof module === "string"
      ? new URL(`data:text/javascript;base64,${await fs.readFile(module, "base64")}`)
      : module;
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
      }), this.options.filterTimeoutMs ?? FILTER_TIMEOUT_MS, "Filtering Chromium trace");
    } finally {
      await worker.terminate();
    }
  }

  private async stop(): Promise<void>;
  private async stop<T>(publish: (rawPath: string) => Promise<T>): Promise<T>;
  private async stop<T>(publish?: (rawPath: string) => Promise<T>): Promise<T | undefined> {
    this.recording = null;
    // The native endpoint writes its temporary file beside the destination.
    // Keep both outside the published capture directory, even on a late flush.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pwrgit-chromium-trace-"));
    const rawPath = path.join(scratch, "trace.json");
    try {
      await withDeadline(this.backend().stopRecording(rawPath),
        this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS, "Stopping Chromium trace");
      this.nativeMayBeRecording = false;
      return await publish?.(rawPath);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch((error) => {
        this.warn("Could not remove private trace staging directory", error);
      });
    }
  }
}
