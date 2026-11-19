import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { logMain } from "../logs";
import { directorySize, type DirSizeResult } from "./dir-size";

type Measure = (root: string) => Promise<DirSizeResult>;

/** One worker handles a stream of candidates from the sweep. It shares a
 * cancellation flag with main because a blocking filesystem call cannot
 * process a message, and returns a partial measurement when the flag flips. */
export async function runPruneSizeWorker(
  workerModule: string | URL,
  signal: AbortSignal,
  run: (measure: Measure) => Promise<void>
): Promise<void> {
  if (signal.aborted) return;
  const fallback: Measure = (root) => directorySize(root, { signal, trackActivity: true });
  const cancelled = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let worker: Worker;
  try {
    // The production asset lives in app.asar. Read it through Electron's
    // filesystem and run those bytes in the worker's standalone ESM loader.
    const entry = typeof workerModule === "string"
      ? new URL(`data:text/javascript;base64,${await readFile(workerModule, "base64")}`)
      : workerModule;
    if (signal.aborted) return;
    worker = new Worker(entry, { workerData: cancelled });
  } catch (error) {
    logMain("warn", "prune", `Could not start the sizing worker: ${String(error)}`);
    await run(fallback);
    return;
  }

  const cancel = (): void => { Atomics.store(cancelled, 0, 1); };
  signal.addEventListener("abort", cancel, { once: true });

  let failure: Error | undefined;
  let pending: {
    resolve: (result: DirSizeResult) => void;
    reject: (error: Error) => void;
  } | undefined;
  const fail = (error: Error): void => {
    failure ??= error;
    pending?.reject(failure);
  };
  worker.on("error", fail);
  worker.once("exit", (code) => fail(new Error(`Sizing worker exited with code ${code}.`)));
  worker.on("message", (result: DirSizeResult) => pending?.resolve(result));

  let measure: Measure = (root) => new Promise((resolve, reject) => {
    if (failure !== undefined) {
      reject(failure);
      return;
    }
    pending = { resolve, reject };
    worker.postMessage(root);
  });
  try {
    await run(async (root) => {
      try {
        return await measure(root);
      } catch (error) {
        logMain("warn", "prune", `Sizing worker failed: ${String(error)}`);
        measure = fallback;
        return fallback(root);
      } finally {
        pending = undefined;
      }
    });
  } finally {
    signal.removeEventListener("abort", cancel);
    await worker.terminate();
  }
}
