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
let withdrawalQueued = false;
let pointer: { x: number; y: number } | undefined;
let hoverBlockedByLayout = false;
const pendingHovers = new Set<() => void>();

function blockLayoutHover(): void {
  hoverBlockedByLayout = true;
  for (const cancel of pendingHovers) cancel();
}

function movedPointer(event: MouseEvent): boolean {
  return pointer !== undefined && (event.clientX !== pointer.x || event.clientY !== pointer.y);
}

function withdraw(): void {
  if (withdrawalQueued) return;
  withdrawalQueued = true;
  blockLayoutHover();
  // A lens change can unmount every row in one React commit. Withdraw once
  // after that commit, rather than scan/report the shrinking set per row.
  queueMicrotask(() => {
    withdrawalQueued = false;
    send();
  });
}

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
  if (observer === null) {
    // One pair of listeners for the window. Layout-generated mouse events at
    // unchanged coordinates are not a deliberate hover after scrolling.
    document.addEventListener("scroll", blockLayoutHover, true);
    document.addEventListener("mousemove", (event) => {
      if (movedPointer(event)) hoverBlockedByLayout = false;
      pointer = { x: event.clientX, y: event.clientY };
    }, { passive: true });
  }
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
    const leave = (): void => {
      clearTimeout(hoverTimer);
      pendingHovers.delete(leave);
    };
    const enter = (raw: Event): void => {
      const event = raw as MouseEvent;
      leave();
      if (hoverBlockedByLayout && !movedPointer(event)) return;
      hoverBlockedByLayout = false;
      pointer = { x: event.clientX, y: event.clientY };
      pendingHovers.add(leave);
      hoverTimer = setTimeout(() => {
        pendingHovers.delete(leave);
        void dispatch("remote:checkSelected", { worktreeId, intent: "hover" });
      }, REMOTE_HOVER_DWELL_MS);
    };
    const move = (raw: Event): void => {
      const event = raw as MouseEvent;
      if (hoverBlockedByLayout && movedPointer(event)) enter(event);
    };
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("mousemove", move);
    return () => {
      leave();
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
      el.removeEventListener("mousemove", move);
      io.unobserve(el);
      rows.delete(el);
      if (seen.delete(el)) withdraw();
    };
  }, [ref, worktreeId]);
}
