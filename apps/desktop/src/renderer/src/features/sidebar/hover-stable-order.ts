/**
 * Merge a held row order with the one the list now wants.
 *
 * Frozen positions win, so nothing already on screen moves; rows the list has
 * since added land at the bottom, the one place where arriving cannot shift
 * what is being read. Rows that genuinely left the list are dropped rather
 * than kept as ghosts — the lens stays the authority on *membership*, and only
 * *position* is held.
 *
 * See `useHoverStableOrder` for why the order is held at all.
 */
export function retainOrder(
  frozen: readonly string[],
  latest: readonly string[]
): string[] {
  const held = new Set(frozen);
  const present = new Set(latest);
  return [
    ...frozen.filter((id) => present.has(id)),
    ...latest.filter((id) => !held.has(id))
  ];
}
