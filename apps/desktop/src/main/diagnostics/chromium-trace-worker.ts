import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { workerData } from "node:worker_threads";

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

function safeTraceEvent(value: unknown, allowedCategories: readonly string[]): Record<string, unknown> | null {
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
  const cat = allowedCategories.filter((known) => categories.includes(known)).join(",");
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

// The native exporter writes traceEvents first, then optional root metadata.
// Frame objects across chunks, leaving JSON syntax and value parsing to V8.
const TRACE_HEADER = /^\s*\{\s*"traceEvents"\s*:\s*\[$/u;
const MAX_FRAGMENT_CHARS = 8 * 1024 * 1024;

function appendFragment(fragment: string, next: string): string {
  if (fragment.length + next.length > MAX_FRAGMENT_CHARS) {
    throw new Error("Chromium trace event or metadata exceeded the filter size limit");
  }
  return fragment + next;
}

function parseJson(fragment: string): unknown {
  try {
    return JSON.parse(fragment);
  } catch {
    // V8's parser error can quote raw trace data.
    throw new Error("Chromium trace contains invalid JSON");
  }
}

async function* filterTrace(rawPath: string, allowedCategories: readonly string[]): AsyncGenerator<string> {
  const input = createReadStream(rawPath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let state: "header" | "first" | "event" | "separator" | "next" | "footer" = "header";
  let fragment = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let wroteEvent = false;
  yield '{"traceEvents":[';
  for await (const chunk of input as AsyncIterable<string>) {
    let cursor = 0;
    let output = "";
    if (state === "header") {
      const end = chunk.indexOf("[");
      fragment = appendFragment(fragment, end < 0 ? chunk : chunk.slice(0, end + 1));
      if (end < 0) continue;
      if (!TRACE_HEADER.test(fragment)) throw new Error("Chromium trace has no event array");
      state = "first";
      fragment = "";
      cursor = end + 1;
    }
    while (cursor < chunk.length) {
      if (state === "footer") {
        fragment = appendFragment(fragment, chunk.slice(cursor));
        break;
      }
      if (state === "event") {
        const start = cursor;
        while (cursor < chunk.length) {
          const char = chunk[cursor++];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') {
            quoted = true;
          } else if (char === "{" || char === "[") {
            depth++;
          } else if (char === "}" || char === "]") {
            if (--depth === 0) break;
          }
        }
        fragment = appendFragment(fragment, chunk.slice(start, cursor));
        if (depth !== 0) continue;
        const safe = safeTraceEvent(parseJson(fragment), allowedCategories);
        if (safe !== null) {
          output += (wroteEvent ? "," : "") + JSON.stringify(safe);
          wroteEvent = true;
        }
        fragment = "";
        state = "separator";
        continue;
      }
      const char = chunk[cursor];
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        cursor++;
      } else if ((state === "first" || state === "separator") && char === "]") {
        state = "footer";
        cursor++;
      } else if (state === "separator" && char === ",") {
        state = "next";
        cursor++;
      } else if ((state === "first" || state === "next") && char === "{") {
        state = "event";
      } else {
        throw new Error("Chromium trace contains an invalid event array");
      }
    }
    if (output) yield output;
  }
  if (state !== "footer") throw new Error("Chromium trace has an incomplete event array");
  parseJson('{"traceEvents":[]' + fragment);
  yield "]}";
}

const { rawPath, filteredPath, allowedCategories } = workerData as {
  rawPath: string;
  filteredPath: string;
  allowedCategories: readonly string[];
};
await pipeline(filterTrace(rawPath, allowedCategories), createWriteStream(filteredPath, { flags: "wx", mode: 0o600 }));
