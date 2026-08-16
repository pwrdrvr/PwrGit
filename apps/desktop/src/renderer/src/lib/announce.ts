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
 * Put the empty region in the DOM. Call this once from a long-lived component
 * at startup.
 *
 * A live region has to be *registered* by the screen reader before the text
 * inside it changes — that registration happens when the element lands in the
 * accessibility tree, and a mutation in the same breath as the insertion is
 * routinely missed. `announce()` creates the region on demand as a fallback,
 * but on the very first call that leaves only one frame between "the region
 * exists" and "the region says something", so the first reorder of a session
 * could go unspoken while every later one worked. Mounting it up front removes
 * that asymmetry.
 */
export function mountLiveRegion(): void {
  region();
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
  // Let the clear land as its own change before the message: setting both in
  // one task collapses into a single mutation, which an unchanged string would
  // not re-announce. A frame is the cheapest reliable gap.
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
