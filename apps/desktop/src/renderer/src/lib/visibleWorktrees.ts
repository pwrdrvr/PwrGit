import { useEffect, type RefObject } from "react";
import { dispatch } from "./pwrgit";

/** Scrolling settles before the window's visible set is sent to main. */
export const VISIBLE_REPORT_DEBOUNCE_MS = 250;
/** Expensive hover work uses the same dwell as the sidebar's PR prefetch. */
export const REMOTE_HOVER_DWELL_MS = 750;

/** Which worktree each observed row stands for. A row may unmount while seen. */
const rows = new Map<Element, string>();
const seen = new Set<Element>();
let observer: IntersectionObserver | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = "";

function send(): void {
  clearTimeout(timer);
  timer = undefined;
  const ids = new Set<string>();
  for (const el of seen) {
    const id = rows.get(el);
    if (id !== undefined) ids.add(id);
  }
  const worktreeIds = [...ids].sort();
  const key = worktreeIds.join("\n");
  if (key === lastSent) return;
  lastSent = key;
  void dispatch("worktree:reportVisible", { worktreeIds });
}

function schedule(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(send, VISIBLE_REPORT_DEBOUNCE_MS);
}

function sharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  observer ??= new IntersectionObserver((entries) => {
    let left = false;
    for (const entry of entries) {
      if (entry.isIntersecting) seen.add(entry.target);
      else left = seen.delete(entry.target) || left;
    }
    // Withdraw queued work immediately, even during a continuous scroll.
    // Additions still settle here and then debounce in main's checker.
    if (left) send();
    schedule();
  });
  return observer;
}

/**
 * Tell main this row is on screen, so local state and remote tips stay current
 * (`VisibleWorktreeRefresher` and `RemoteTipChecker`). Main owns the budgets;
 * visibility reports only describe what the window is showing —
 * one IntersectionObserver for every row, and one debounced report per
 * change of the set, never one per row.
 *
 * The repo row reports its primary checkout, whose count its badge shows;
 * the same id from that checkout's own row is folded into one. `worktreeId`
 * null registers nothing. A deliberate row hover asks for an immediate check.
 */
export function useReportVisible(
  ref: RefObject<Element | null>,
  worktreeId: string | null
): void {
  useEffect(() => {
    const el = ref.current;
    const io = sharedObserver();
    if (el === null || io === null || worktreeId === null) return;
    rows.set(el, worktreeId);
    io.observe(el);
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const leave = (): void => { clearTimeout(hoverTimer); };
    const enter = (): void => {
      leave();
      hoverTimer = setTimeout(() => {
        void dispatch("remote:checkSelected", { worktreeId, intent: "hover" });
      }, REMOTE_HOVER_DWELL_MS);
    };
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      leave();
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
      io.unobserve(el);
      rows.delete(el);
      if (seen.delete(el)) send();
    };
  }, [ref, worktreeId]);
}
