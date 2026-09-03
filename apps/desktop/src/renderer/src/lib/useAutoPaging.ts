import { useEffect, useRef, useState } from "react";

/**
 * Page in the next block when a "load more" control scrolls into view.
 *
 * The control stays on screen either way: it is the keyboard affordance, the
 * fallback where IntersectionObserver is unavailable, and the retry after a
 * page that failed.
 *
 * Two guards, both load-bearing:
 *
 * - **`error` stops the fill.** Re-observing once `loading` clears is what
 *   makes this fill a tall viewport — the control does not move enough to emit
 *   a fresh intersection of its own. But a page that FAILS also clears
 *   `loading` without advancing the cursor, so the same re-observe fired the
 *   same request again, immediately and forever. A failed page waits for the
 *   reader to press the button.
 * - **`requested` is never asked twice.** Belt to that brace: whatever the
 *   caller returns, this hook asks for any one cursor at most once. A manual
 *   click is a deliberate act and bypasses it, so retry still works.
 */
export function useAutoPaging(
  nextCursor: string | null,
  loading: boolean,
  error: string | null,
  load: (cursor: string) => void
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (node === null || nextCursor === null || loading || error !== null) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (requested.current === nextCursor) return;
      requested.current = nextCursor;
      loadRef.current(nextCursor);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, nextCursor, loading, error]);

  return setNode;
}
