import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

// Every relative-time consumer in one renderer subscribes to this store, so
// the app owns one minute-aligned timer instead of a timer per row or panel.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;

function minuteBucket(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS);
}

function notify(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function catchUp(): void {
  const current = Date.now();
  if (minuteBucket(current) === minuteBucket(now)) return;
  now = current;
  for (const listener of listeners) listener();
}

function scheduleNextTick(): void {
  if (timer !== undefined || listeners.size === 0) return;
  // Tick just after the next minute boundary. Labels only show whole minutes,
  // so this is both precise and much cheaper than a per-second repaint.
  const delay = MINUTE_MS - (Date.now() % MINUTE_MS) + 20;
  timer = setTimeout(() => {
    timer = undefined;
    notify();
    scheduleNextTick();
  }, delay);
}

function onWindowFocus(): void {
  // Background windows can have their timers throttled. Catch up before the
  // user sees the window again when a minute boundary passed while away,
  // without re-rendering every timestamp consumer on same-minute focus churn.
  catchUp();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") catchUp();
}

function start(): void {
  now = Date.now();
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  scheduleNextTick();
}

function stop(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  window.removeEventListener("focus", onWindowFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

function subscribe(listener: () => void): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const getSnapshot = (): number => now;

/** A renderer-wide, minute-aligned "now" value for relative timestamps. */
export function useRelativeClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
