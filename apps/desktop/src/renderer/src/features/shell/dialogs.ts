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

/** One answer to a question that has more than two of them. */
export type DialogChoice = {
  /** Returned by `chooseDialog` when this one is picked. */
  id: string;
  label: string;
  /** What picking it does, in one line. A choice whose consequence the reader
   *  has to infer from a verb is a guess, not a decision. */
  detail?: string;
  danger?: boolean;
};

/**
 * A question with three or more answers, where "Cancel" is genuinely a third
 * answer and not the negation of the other two.
 *
 * Separate from `confirmDialog` rather than an option on it: a confirm asks
 * whether to do the one thing the user already asked for, and its Enter/Escape
 * pair means yes/no. Here Escape still means "do nothing", but Enter cannot
 * mean "yes" when there are two yeses — so the choices are buttons the reader
 * picks from, each carrying its own consequence.
 */
export type ChooseOptions = {
  title: string;
  message: string;
  /** Observable state under the message — the paths at stake, say. Listed, not
   *  prose, because the reader is scanning it rather than reading it. */
  facts?: string[];
  /** First is the default, and takes focus. */
  choices: DialogChoice[];
  cancelLabel?: string;
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
    }
  | {
      kind: "choose";
      id: number;
      opts: ChooseOptions;
      /** Null when the reader cancelled, by button, Escape, or backdrop. */
      resolve: (choice: string | null) => void;
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

/** Ask a question with more than two answers. Resolves the chosen `id`, or
 *  null when the reader declined to answer. */
export function chooseDialog(opts: ChooseOptions): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ kind: "choose", id: ++counter, opts, resolve });
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

/**
 * Called by DialogHost when the user answers.
 *
 * `answer` is a boolean for a confirm and the chosen id — or null — for a
 * choice. `false` and `null` both mean the same thing to a chooser, so the
 * shared Escape/backdrop path can keep passing `false`.
 */
export function closeDialog(id: number, answer: boolean | string): void {
  const dialog = queue.find((d) => d.id === id);
  if (dialog === undefined) return;
  queue = queue.filter((d) => d.id !== id);
  if (dialog.kind === "confirm") dialog.resolve(answer === true);
  else if (dialog.kind === "choose") {
    dialog.resolve(typeof answer === "string" ? answer : null);
  } else dialog.resolve();
  emit();
}
