import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * The WAI-ARIA tablist keyboard contract: Left/Right wrap around the strip,
 * Home/End jump to its ends.
 *
 * Paired with a roving tab stop (`tabIndex={selected ? 0 : -1}` on each tab)
 * this is what `role="tablist"` promises — one Tab stop for the whole strip,
 * arrows to move inside it. `FileInsightsPane` had it hand-rolled and
 * `LensFilter` had nothing at all, so its chips were each a separate tab stop
 * and the arrows did nothing.
 *
 * Returns the tab to select, or `undefined` when the key is not ours — in which
 * case the caller must leave the event alone.
 */
export function nextTabForKey<T>(
  key: string,
  order: readonly T[],
  current: T
): T | undefined {
  const last = order.length - 1;
  if (last < 0) return undefined;
  const index = order.indexOf(current);
  if (index === -1) return undefined;
  switch (key) {
    case "ArrowRight":
      return order[index === last ? 0 : index + 1];
    case "ArrowLeft":
      return order[index === 0 ? last : index - 1];
    case "Home":
      return order[0];
    case "End":
      return order[last];
    default:
      return undefined;
  }
}

/**
 * `onKeyDown` for a tablist container. `select` both moves the selection and
 * owes focus to the newly selected tab — in a tablist the two travel together,
 * which is what makes the strip announce itself as you arrow along it.
 */
export function tablistKeyHandler<T>(
  order: readonly T[],
  current: T,
  select: (next: T) => void
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return (event) => {
    const next = nextTabForKey(event.key, order, current);
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };
}
