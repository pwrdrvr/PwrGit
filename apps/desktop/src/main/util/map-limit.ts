import { BlockingQueue, IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";

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
  // A reusable pool owns permits rather than a finite mapper's input stream.
  const permits = new BlockingQueue<number>({ maxUnread: ceiling });
  const ready = Promise.all(Array.from({ length: ceiling }, (_, i) => permits.enqueue(i)));
  return async (...args) => {
    await ready;
    const permit = await permits.dequeue();
    try { return await fn(...args); }
    finally { await permits.enqueue(permit!); }
  };
}
