// App-wide error toasts (PwrAgnt's AppNoticeToast pattern, store-ified so any
// feature can raise one without prop drilling). ToastHost renders the stack.

export type Toast = {
  id: number;
  title: string;
  message: string;
  detail?: string;
  /** Offer an "Open Logs" action (default true for errors). */
  showLogsAction?: boolean;
};

type ToastListener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<ToastListener>();

function notify(): void {
  for (const listener of listeners) listener(toasts);
}

export function showErrorToast(input: {
  title: string;
  message: string;
  detail?: string;
}): void {
  toasts = [
    ...toasts,
    { id: nextId, showLogsAction: true, ...input }
  ];
  nextId += 1;
  notify();
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  notify();
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
