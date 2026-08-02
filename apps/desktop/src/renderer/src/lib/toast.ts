// App-wide error toasts (PwrAgnt's AppNoticeToast pattern, store-ified so any
// feature can raise one without prop drilling). ToastHost renders the stack.

export type Toast = {
  id: number;
  title: string;
  message: string;
  detail?: string;
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
  toasts = [...toasts, { id: nextId, ...input }];
  nextId += 1;
  notify();
}

export function showErrorToast(input: {
  title: string;
  message: string;
  detail?: string;
}): void {
  pushToast({ showLogsAction: true, showCopyAction: true, ...input });
}

export function showInfoToast(input: {
  title: string;
  message: string;
}): void {
  pushToast({ showLogsAction: false, showCopyAction: false, ...input });
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
