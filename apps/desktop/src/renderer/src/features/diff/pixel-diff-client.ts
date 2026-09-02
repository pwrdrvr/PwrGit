import type { DiffReply, DiffRequest } from "./pixel-diff";

/**
 * A promise in front of `pixel-diff.worker.ts`.
 *
 * One worker for the whole renderer, created on first use and kept: spinning
 * one up per lightbox meant a fresh module parse on every open, and the copy
 * menu needs to run a comparison from the inline row too, where no lightbox
 * exists to own one.
 */

export type PixelDiffResult = { png: Blob; changed: number; total: number };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: PixelDiffResult) => void; reject: (why: Error) => void }
>();

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  const created = new Worker(
    new URL("./pixel-diff.worker.ts", import.meta.url),
    { type: "module" }
  );
  created.addEventListener("message", (event: MessageEvent<DiffReply>) => {
    const reply = event.data;
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    if (reply.ok) {
      waiting.resolve({
        png: reply.png,
        changed: reply.changed,
        total: reply.total
      });
    } else {
      waiting.reject(new Error(reply.error));
    }
  });
  created.addEventListener("error", () => {
    // A worker-level failure kills every request on it, not just the current
    // one, so nothing is left waiting on a reply that can no longer come.
    for (const waiting of pending.values()) {
      waiting.reject(new Error("the comparison crashed"));
    }
    pending.clear();
    worker = null;
  });
  worker = created;
  return created;
}

export function pixelDiffSupported(): boolean {
  return typeof Worker !== "undefined";
}

export function computePixelDiff(
  request: Omit<DiffRequest, "id">
): Promise<PixelDiffResult> {
  if (!pixelDiffSupported()) {
    return Promise.reject(new Error("not supported here"));
  }
  let active: Worker;
  try {
    active = ensureWorker();
  } catch {
    return Promise.reject(new Error("not supported here"));
  }
  const id = (nextId += 1);
  return new Promise<PixelDiffResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage({ ...request, id } satisfies DiffRequest);
  });
}
