import { useEffect, type RefObject } from "react";
import { dispatch } from "./pwrgit";

/** Scrolling settles before the window's visible set is sent to main. */
export const VISIBLE_REPORT_DEBOUNCE_MS = 250;

/** Which worktree each observed row stands for. A row may unmount while seen. */
const rows = new Map<Element, string>();
const seen = new Set<Element>();
let observer: IntersectionObserver | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = "";

function send(): void {
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
    for (const entry of entries) {
      if (entry.isIntersecting) seen.add(entry.target);
      else seen.delete(entry.target);
    }
    schedule();
  });
  return observer;
}

/**
 * Tell main this row is on screen, so the worktree it shows stays current
 * with work done outside PwrGit (Fork Sync, 3f). Main decides what that costs
 * (`VisibleWorktreeRefresher`); this only says what the window is showing —
 * one IntersectionObserver for every row, and one debounced report per
 * change of the set, never one per row.
 *
 * The repo row reports its primary checkout, whose count its badge shows;
 * the same id from that checkout's own row is folded into one. `worktreeId`
 * null registers nothing.
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
    return () => {
      io.unobserve(el);
      rows.delete(el);
      if (seen.delete(el)) schedule();
    };
  }, [ref, worktreeId]);
}
