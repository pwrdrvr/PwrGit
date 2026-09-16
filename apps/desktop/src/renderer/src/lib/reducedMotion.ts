/**
 * Whether the reader has asked for less motion.
 *
 * One reader for the whole renderer. Three copies of this query had grown —
 * two of them without the `matchMedia` guard — and "what counts as reduced
 * motion" is exactly the kind of decision that has to have one answer: a card
 * that drops its countdown animation while the graph keeps its smooth scroll
 * is worse than either choice made consistently.
 *
 * Defensive about `matchMedia` itself: jsdom and other non-browser hosts may
 * not carry one.
 *
 * Asked at the moment it matters rather than watched. A preference that
 * changes mid-session is rare enough not to be worth a listener, and callers
 * that need it per render latch it in state.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
