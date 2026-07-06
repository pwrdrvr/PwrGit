import { IterableQueueMapperSimple } from "@shutterstock/p-map-iterable";

/**
 * Run `fn` over `items` with bounded concurrency + backpressure via
 * @shutterstock/p-map-iterable (the parallelism control the sibling apps use),
 * so a large fan-out (e.g. 156 worktrees × git calls) never spawns an
 * unbounded process storm.
 */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const queue = new IterableQueueMapperSimple<T>(fn, {
    concurrency: Math.max(1, limit)
  });
  for (const item of items) await queue.enqueue(item);
  await queue.onIdle();
}
