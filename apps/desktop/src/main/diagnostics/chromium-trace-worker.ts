import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { traceJsonFragment } from "./chromium-trace-json.ts";

export type ChromiumTraceFilterResult = { cpuMs: number } | { error: string };

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
const LINEAGE_MARK = /^PwrGit Lineage (request|publish) (view|branch-pr|repo-change) view=[0-9]{1,9} target=[1-9][0-9]{0,8}$/u;

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
  const userTiming = categories.includes("blink.user_timing");
  const name = typeof event.name === "string" &&
    (TIMING_NAMES.has(event.name) || (userTiming && LINEAGE_MARK.test(event.name)))
    ? event.name
    : userTiming ? "User timing" : "Other";
  const safe: Record<string, unknown> = { ...track, cat, name, ph: event.ph, ts: event.ts };
  for (const key of ["dur", "tts", "tdur"]) {
    if (typeof event[key] === "number") safe[key] = event[key];
  }
  if (event.ph === "I" || event.ph === "i") safe.s = "t";
  return safe;
}

// The native exporter writes traceEvents first, then optional root metadata.
// Frame objects across chunks and pass each one to the fragment parser.
const TRACE_HEADER = /^\s*\{\s*"traceEvents"\s*:\s*\[$/u;

async function* filterTrace(rawPath: string, allowedCategories: readonly string[]): AsyncGenerator<string> {
  const input = createReadStream(rawPath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let state: "header" | "first" | "event" | "separator" | "next" | "footer" = "header";
  let header = "";
  const event = traceJsonFragment(allowedCategories);
  const footer = traceJsonFragment();
  footer.append('{"traceEvents":[]');
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
      header += end < 0 ? chunk : chunk.slice(0, end + 1);
      if (header.length > 8 * 1024 * 1024) throw new Error("Chromium trace has no event array");
      if (end < 0) continue;
      if (!TRACE_HEADER.test(header)) throw new Error("Chromium trace has no event array");
      state = "first";
      header = "";
      cursor = end + 1;
    }
    while (cursor < chunk.length) {
      if (state === "footer") {
        footer.append(chunk.slice(cursor));
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
        event.append(chunk.slice(start, cursor));
        if (depth !== 0) continue;
        const safe = safeTraceEvent(event.finish(), allowedCategories);
        if (safe !== null) {
          output += (wroteEvent ? "," : "") + JSON.stringify(safe);
          wroteEvent = true;
        }
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
  footer.finish();
  yield "]}";
}

if (isMainThread) {
  // Run the existing heap-limited worker in a utility process so its CPU
  // (including I/O and V8 background work) is outside the browser process.
  // Load the self-contained bundle through Electron's ASAR-aware filesystem.
  try {
    const [rawPath, filteredPath, ...allowedCategories] = process.argv.slice(2);
    const source = await readFile(fileURLToPath(import.meta.url), "base64");
    const worker = new Worker(new URL(`data:text/javascript;base64,${source}`), {
      workerData: { rawPath, filteredPath, allowedCategories },
      resourceLimits: { maxOldGenerationSizeMb: 96 }
    });
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Chromium trace filter exited with code ${code}`));
      });
    });
    const { user, system } = process.cpuUsage();
    process.parentPort.postMessage({ cpuMs: (user + system) / 1_000 } satisfies ChromiumTraceFilterResult);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chromium trace filter failed";
    process.parentPort.postMessage({ error: message } satisfies ChromiumTraceFilterResult);
    process.exit(1);
  }
} else {
  const { rawPath, filteredPath, allowedCategories } = workerData as {
    rawPath: string;
    filteredPath: string;
    allowedCategories: readonly string[];
  };
  await pipeline(filterTrace(rawPath, allowedCategories), createWriteStream(filteredPath, { flags: "wx", mode: 0o600 }));
}
