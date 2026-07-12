import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";

/**
 * Reusable "fill lazily, cancel eagerly" queue for async UI enrichment —
 * e.g. per-row status that appears as rows become visible.
 *
 * The shape (per PwrSnap/PwrAgnt practice, built on
 * @shutterstock/p-map-iterable):
 *  - request(key, run): the work is DEBOUNCED before it's enqueued, so rows
 *    that merely flash past during a scroll never generate work at all.
 *  - A dictionary owns every pending item. cancel(key) marks it canceled:
 *    if it hasn't been enqueued yet it's dropped outright; if it's already
 *    in the queue, the mapper sees the canceled flag when it pulls the item
 *    and tosses it — costing nothing — then pulls the next one.
 *  - Concurrency is bounded by the mapper, so at most `concurrency` fills
 *    run at once no matter how fast requests arrive.
 *  - Re-requesting a canceled-but-still-queued key revives it in place.
 */
export type AsyncFill<K> = {
  /** Ask for `run` to execute for `key` after the debounce window. */
  request: (key: K, run: () => Promise<void>) => void;
  /** Cancel a pending key (no-op if unknown/already done). */
  cancel: (key: K) => void;
  cancelAll: () => void;
};

export function createAsyncFill<K>(
  opts: { concurrency?: number; debounceMs?: number } = {}
): AsyncFill<K> {
  const { concurrency = 3, debounceMs = 200 } = opts;

  type Entry = {
    canceled: boolean;
    /** Set while debouncing; null once enqueued. */
    timer: ReturnType<typeof setTimeout> | null;
    run: () => Promise<void>;
  };
  const entries = new Map<K, Entry>();

  const queue = new IterableQueueMapperSimple<K>(
    async (key) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      if (entry.canceled) {
        // Tossed at pull time — the whole point of the canceled flag.
        entries.delete(key);
        return;
      }
      entries.delete(key);
      try {
        await entry.run();
      } catch {
        // Fills are best-effort decoration; a failure just leaves the row bare.
      }
    },
    { concurrency }
  );

  const request = (key: K, run: () => Promise<void>): void => {
    const existing = entries.get(key);
    if (existing !== undefined) {
      // Revive/refresh in place — whether debouncing or already queued.
      existing.run = run;
      existing.canceled = false;
      return;
    }
    const entry: Entry = { canceled: false, timer: null, run };
    entries.set(key, entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!entry.canceled) void queue.enqueue(key);
      else entries.delete(key);
    }, debounceMs);
  };

  const cancel = (key: K): void => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entry.canceled = true;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entries.delete(key);
    }
    // Already enqueued: leave the tombstone for the mapper to toss.
  };

  return {
    request,
    cancel,
    cancelAll: () => {
      for (const key of [...entries.keys()]) cancel(key);
    }
  };
}
