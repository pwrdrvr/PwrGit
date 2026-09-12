/**
 * The one "a batch that fails keeps the batches before it" decision, shared by
 * every forge client — the same reason `retry.ts` exists: both clients used to
 * carry a copy, so a fix to one silently missed the other.
 *
 * See "A batch that fails keeps the batches before it" in ./AGENTS.md for the
 * policy this implements and why it stops rather than skipping ahead.
 */

/**
 * Walk `keys` in chunks, keeping whatever the earlier chunks resolved.
 *
 * `fetchChunk` is the only call inside the `try`, and `parseChunk` deliberately
 * sits outside it: a parser throwing is a bug in us, not a refusal by the
 * forge, and swallowing it would turn a `TypeError` into a silent short map
 * whose visibility depends on how many keys the repo happens to have.
 *
 * A chunk that fails ends the walk rather than skipping to the next — a
 * revoked token or a complexity cap refuses every chunk alike, so continuing
 * would spend the whole retry budget again per chunk for an answer that cannot
 * change. Only a first chunk failing rethrows, because "nothing resolved" is
 * what callers must never read as "no change request anywhere".
 */
export async function fetchInChunks<K, V, Raw>(
  keys: readonly K[],
  size: number,
  fetchChunk: (chunk: K[]) => Promise<Raw>,
  parseChunk: (chunk: K[], raw: Raw) => Iterable<readonly [K, V]>
): Promise<Map<K, V>> {
  const result = new Map<K, V>();
  for (let i = 0; i < keys.length; i += size) {
    const chunk = keys.slice(i, i + size);
    let raw: Raw;
    try {
      raw = await fetchChunk(chunk);
    } catch (error) {
      if (result.size === 0) throw error;
      return result;
    }
    for (const [key, value] of parseChunk(chunk, raw)) result.set(key, value);
  }
  return result;
}
