// A small imperative dialog service so any code — hooks, event handlers, async
// flows — can `await confirm(...)` / `await notify(...)` and get a styled
// in-app dialog instead of the OS window.confirm/alert. <DialogHost/> (mounted
// once in App) renders whatever is at the front of the queue.

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type NotifyOptions = {
  title: string;
  message: string;
  okLabel?: string;
};

export type PendingDialog =
  | {
      kind: "confirm";
      id: number;
      opts: ConfirmOptions;
      resolve: (ok: boolean) => void;
    }
  | {
      kind: "notify";
      id: number;
      opts: NotifyOptions;
      resolve: () => void;
    };

let queue: PendingDialog[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeDialogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The dialog to show (front of queue), or null. Stable reference when idle. */
export function currentDialog(): PendingDialog | null {
  return queue[0] ?? null;
}

/** Styled replacement for window.confirm — resolves true on confirm. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ kind: "confirm", id: ++counter, opts, resolve });
    emit();
  });
}

/** Styled replacement for window.alert — resolves when dismissed. */
export function notifyDialog(opts: NotifyOptions): Promise<void> {
  return new Promise((resolve) => {
    queue.push({ kind: "notify", id: ++counter, opts, resolve });
    emit();
  });
}

/** Called by DialogHost when the user answers. */
export function closeDialog(id: number, confirmed: boolean): void {
  const dialog = queue.find((d) => d.id === id);
  if (dialog === undefined) return;
  queue = queue.filter((d) => d.id !== id);
  if (dialog.kind === "confirm") dialog.resolve(confirmed);
  else dialog.resolve();
  emit();
}
