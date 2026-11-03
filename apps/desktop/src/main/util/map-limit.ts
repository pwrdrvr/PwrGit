import { IterableQueueMapperSimple, Queue } from "@shutterstock/p-map-iterable";

/**
 * Run `fn` over `items` with bounded concurrency + backpressure via
 * @shutterstock/p-map-iterable (the parallelism control the sibling apps use),
 * so a large fan-out (e.g. 156 worktrees × git calls) never spawns an
 * unbounded process storm.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const queue = new IterableQueueMapperSimple<number>(async (index) => {
    results[index] = await fn(items[index]!, index);
  }, {
    concurrency: Math.max(1, limit)
  });
  for (let index = 0; index < items.length; index += 1) await queue.enqueue(index);
  await queue.onIdle();
  // The queue collects exceptions instead of rejecting onIdle. Drain first,
  // so a caller's lock covers every accepted task even when a worker fails.
  if (queue.errors.length > 0) throw queue.errors[0]!.error;
  return results;
}

/** Share a ceiling across overlapping calls for the lifetime of an owner. */
export function limitConcurrency<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  limit: number
): (...args: A) => Promise<R> {
  const ceiling = Math.max(1, limit);
  if (!Number.isSafeInteger(ceiling)) throw new TypeError("Expected a finite integer concurrency limit");
  let available = ceiling;
  const waiting = new Queue<() => void>();
  return async (...args) => {
    if (available > 0) available -= 1;
    else await new Promise<void>((resolve) => { waiting.enqueue(resolve); });
    try { return await fn(...args); }
    finally {
      const next = waiting.dequeue();
      // Reserve the permit for the oldest waiter before its continuation runs.
      if (next) next();
      else available += 1;
    }
  };
}
