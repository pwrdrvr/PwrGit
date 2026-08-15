/**
 * A single polite live region for status messages that have no visible text of
 * their own (WCAG SC 4.1.3).
 *
 * The case that motivated it: ⌘⇧↑/↓ reorders a sidebar row and deliberately
 * keeps focus on the row that moved, so nothing is re-announced — a sighted
 * user watches the row travel, and a screen-reader user gets silence. The rows
 * carry `aria-posinset`/`aria-setsize`, so the new position is *discoverable*,
 * but discoverable is not announced.
 *
 * One region, created lazily and shared, rather than one per list: several
 * simultaneously-mounted regions make the order of announcements depend on DOM
 * order, and only one message is ever in flight here.
 */

const REGION_ID = "pwrgit-live-region";

function region(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(REGION_ID);
  if (existing !== null) return existing;
  const node = document.createElement("div");
  node.id = REGION_ID;
  node.className = "a11y-sr-only";
  // `polite` so a reorder never interrupts what the user is reading, and
  // `atomic` so the whole sentence is read rather than the diff against the
  // previous one ("3 of 8" -> "4 of 8" would otherwise announce just "4").
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
  document.body.appendChild(node);
  return node;
}

/**
 * Speak `message` politely. Repeating an identical string is a no-op in most
 * screen readers (the node's text never changes), so clear first — pressing
 * ⌘⇧↓ twice at the end of a list should confirm twice, not once.
 */
export function announce(message: string): void {
  const node = region();
  if (node === null) return;
  node.textContent = "";
  // A microtask is enough for the clear to be observed as a mutation; a
  // synchronous re-set collapses into one change and is not re-announced.
  window.requestAnimationFrame(() => {
    node.textContent = message;
  });
}

/** "alpha moved to 2 of 3." — the sentence both reorder gestures announce. */
export const movedMessage = (
  name: string,
  position: number,
  total: number
): string => `${name} moved to ${position} of ${total}.`;
