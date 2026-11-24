import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// Vitest has no Electron. Use the real parser in a worker-backed process
// double. The hidden Electron spec covers the actual utility/ASAR boundary.
export function forkTraceWorker(entry: string, [rawPath, filteredPath, ...allowedCategories]: string[]) {
  const worker = new Worker(entry.startsWith("data:") ? new URL(entry) : pathToFileURL(entry), {
    workerData: { rawPath, filteredPath, allowedCategories },
    resourceLimits: { maxOldGenerationSizeMb: 96 }
  });
  const child = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined,
    kill() { void worker.terminate(); }
  });
  worker.once("online", () => { child.pid = worker.threadId; child.emit("spawn"); });
  worker.once("error", (error) => child.emit("message", { error: error.message }));
  worker.once("exit", (code) => {
    child.pid = undefined;
    if (code === 0) child.emit("message", { cpuMs: 0 });
    child.emit("exit", code);
  });
  return child;
}
