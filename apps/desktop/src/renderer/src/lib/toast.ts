// App-wide error toasts (PwrAgnt's AppNoticeToast pattern, store-ified so any
// feature can raise one without prop drilling). ToastHost renders the stack.

export type Toast = {
  id: number;
  /** Stable identity for a toast that reports a live outcome. Raising the
   *  same key again replaces that toast where it stands instead of stacking a
   *  second one — "Checking for updates…" becoming "You're up to date" is one
   *  toast changing its mind, not two notices. */
  key?: string;
  title: string;
  message: string;
  detail?: string;
  /** Errors head the card in the danger color; anything else is not a
   *  failure and must not be dressed as one. */
  tone: "error" | "info";
  /** Offer an "Open Logs" action (default true for errors). */
  showLogsAction?: boolean;
  /** Offer a copy action (default true for errors). */
  showCopyAction?: boolean;
};

type ToastListener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<ToastListener>();

function notify(): void {
  for (const listener of listeners) listener(toasts);
}

function pushToast(input: Omit<Toast, "id">): void {
  const next: Toast = { id: nextId, ...input };
  nextId += 1;
  const replacing =
    input.key === undefined
      ? -1
      : toasts.findIndex((toast) => toast.key === input.key);
  // The fresh id matters: ToastHost's auto-dismiss keys off it, so a
  // replacement gets a full countdown rather than inheriting however much of
  // the previous toast's had already run down.
  toasts =
    replacing === -1
      ? [...toasts, next]
      : toasts.map((toast, i) => (i === replacing ? next : toast));
  notify();
}

export function showErrorToast(input: {
  key?: string;
  title: string;
  message: string;
  detail?: string;
}): void {
  pushToast({
    ...input,
    tone: "error",
    showLogsAction: true,
    showCopyAction: true
  });
}

export function showInfoToast(input: {
  key?: string;
  title: string;
  message: string;
}): void {
  pushToast({
    ...input,
    tone: "info",
    showLogsAction: false,
    showCopyAction: false
  });
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  notify();
}

/** Take down a keyed toast whose outcome is now being shown elsewhere. No-op
 *  when nothing holds the key. */
export function dismissToastKey(key: string): void {
  const remaining = toasts.filter((toast) => toast.key !== key);
  if (remaining.length === toasts.length) return;
  toasts = remaining;
  notify();
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
