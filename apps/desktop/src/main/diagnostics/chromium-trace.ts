import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContentTracing, TraceConfig } from "electron";

const TRACE_CATEGORIES = ["devtools.timeline", "blink.user_timing", "cc", "viz"];
const MAX_RAW_TRACE_BYTES = 96 * 1024 * 1024;
const START_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 4_000;

// Electron 44 types call this recording_mode, but the object is passed through
// to Chromium's TraceConfig dictionary parser, which reads record_mode.
type ChromiumTraceConfig = Omit<TraceConfig, "recording_mode"> & {
  record_mode: "record-continuously";
};

type TraceBackend = Pick<ContentTracing, "stopRecording"> & {
  startRecording: (config: ChromiumTraceConfig) => Promise<void>;
};

type ChromiumTraceCapture =
  | { status: "written"; recordingStartedAtMs: number; recordingStoppedAtMs: number }
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" };

type TraceOptions = {
  wallNow?: () => number;
  monotonicNow?: () => number;
  bufferSizeKb?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
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

// The native JSON exporter can include URLs, arbitrary User Timing names and
// nested metadata regardless of enable_argument_filter. Rebuild the artifact
// from safe timing fields and stable labels instead of copying raw strings.
const TIMING_NAMES = new Set([
  "RunTask", "ThreadControllerImpl::RunTask", "FunctionCall", "EvaluateScript",
  "UpdateLayoutTree", "RecalculateStyles", "Layout", "PrePaint", "Paint",
  "PaintImage", "RasterTask", "CompositeLayers", "Commit", "DrawFrame",
  "BeginFrame", "BeginMainThreadFrame", "FireAnimationFrame", "EventDispatch",
  "ResourceSendRequest", "ResourceReceiveResponse", "ResourceFinish",
  "Graphics.Pipeline", "Scheduler::BeginFrame", "LayerTreeHostImpl::NotifyTileStateChanged",
  "RasterizerTaskImpl::RunOnWorkerThread", "GpuRasterBuffer::Playback",
  "DisplayScheduler::ScheduleBeginFrameDeadline", "ExternalBeginFrameSource::OnBeginFrame"
]);
const TRACK_NAMES = new Set([
  "Browser", "Renderer", "GPU Process", "CrBrowserMain", "CrRendererMain",
  "CrGpuMain", "Compositor", "VizCompositorThread", "CompositorTileWorker",
  "ThreadPoolForegroundWorker", "ThreadPoolBackgroundWorker"
]);
const TIMING_PHASES = new Set(["B", "E", "X", "I", "i", "R"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function safeTraceEvent(value: unknown): Record<string, unknown> | null {
  const event = record(value);
  if (!event || typeof event.pid !== "number" || typeof event.tid !== "number") return null;
  const track = { pid: event.pid, tid: event.tid };
  if (event.ph === "M" && (event.name === "thread_name" || event.name === "process_name")) {
    const name = record(event.args)?.name;
    return typeof name === "string" && TRACK_NAMES.has(name)
      ? { ...track, ph: "M", cat: "__metadata", name: event.name, args: { name } }
      : null;
  }
  if (typeof event.ph !== "string" || !TIMING_PHASES.has(event.ph) ||
      typeof event.ts !== "number" || typeof event.cat !== "string") return null;
  const categories = event.cat.split(",");
  const cat = TRACE_CATEGORIES.filter((known) => categories.includes(known)).join(",");
  if (!cat) return null;
  const name = typeof event.name === "string" && TIMING_NAMES.has(event.name)
    ? event.name
    : categories.includes("blink.user_timing") ? "User timing" : "Other";
  const safe: Record<string, unknown> = { ...track, cat, name, ph: event.ph, ts: event.ts };
  for (const key of ["dur", "tts", "tdur"]) {
    if (typeof event[key] === "number") safe[key] = event[key];
  }
  if (event.ph === "I" || event.ph === "i") safe.s = "t";
  return safe;
}

async function writeFilteredTrace(rawPath: string, filePath: string): Promise<void> {
  if ((await fs.stat(rawPath)).size > MAX_RAW_TRACE_BYTES) {
    throw new Error("Chromium trace exceeded the export size limit");
  }
  const trace = record(JSON.parse(await fs.readFile(rawPath, "utf8")));
  if (!Array.isArray(trace?.traceEvents)) throw new Error("Chromium trace has no event array");
  const traceEvents = trace.traceEvents.flatMap((event: unknown) => {
    const safe = safeTraceEvent(event);
    return safe ? [safe] : [];
  });
  await fs.writeFile(filePath, JSON.stringify({ traceEvents }), "utf8");
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
      await this.stop((rawPath) => writeFilteredTrace(rawPath, filePath));
      return { status: "written", recordingStartedAtMs: recording.wallMs, recordingStoppedAtMs };
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

  private async stop(publish?: (rawPath: string) => Promise<void>): Promise<void> {
    this.recording = null;
    // The native endpoint writes its temporary file beside the destination.
    // Keep both outside the published capture directory, even on a late flush.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pwrgit-chromium-trace-"));
    const rawPath = path.join(scratch, "trace.json");
    try {
      await withDeadline(this.backend().stopRecording(rawPath),
        this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS, "Stopping Chromium trace");
      this.nativeMayBeRecording = false;
      await publish?.(rawPath);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch((error) => {
        this.warn("Could not remove private trace staging directory", error);
      });
    }
  }
}
