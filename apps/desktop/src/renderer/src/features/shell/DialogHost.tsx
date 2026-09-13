import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type RefObject
} from "react";
import {
  closeDialog,
  currentDialog,
  subscribeDialogs,
  type PendingDialog
} from "./dialogs";

/**
 * Renders the front-of-queue dialog from the imperative dialog service. Mount
 * once, near the app root. Enter confirms, Escape cancels, backdrop click
 * cancels. Focus lands on the primary button so keyboard users can act at once.
 */
export function DialogHost() {
  const dialog = useSyncExternalStore(
    subscribeDialogs,
    currentDialog,
    currentDialog
  );
  const primaryRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (dialog === null) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDialog(dialog.id, false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        // A chooser's Enter takes the focused button rather than a fixed
        // "yes" — with two affirmative answers there is no yes to take, and
        // picking one for the reader is the guess the dialog exists to avoid.
        //
        // Scoped to the panel: nothing here traps focus, so Shift+Tab off the
        // first choice walks into the app behind the dialog. Clicking whatever
        // happened to be focused would fire an unrelated control — a Delete, a
        // Fetch — while the reader believed they were answering the question.
        if (dialog.kind === "choose") {
          const active = document.activeElement;
          if (
            active instanceof HTMLButtonElement &&
            panelRef.current?.contains(active) === true
          ) {
            active.click();
          }
          return;
        }
        closeDialog(dialog.id, true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog]);

  if (dialog === null) return null;
  return (
    <DialogView dialog={dialog} primaryRef={primaryRef} panelRef={panelRef} />
  );
}

function DialogView({
  dialog,
  primaryRef,
  panelRef
}: {
  dialog: PendingDialog;
  primaryRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  if (dialog.kind === "choose") {
    return (
      <ChoiceView dialog={dialog} primaryRef={primaryRef} panelRef={panelRef} />
    );
  }
  // Inline `dialog.kind` checks so the discriminated union narrows `opts`.
  const danger = dialog.kind === "confirm" && dialog.opts.danger === true;
  const confirmLabel =
    dialog.kind === "confirm"
      ? (dialog.opts.confirmLabel ?? "Confirm")
      : (dialog.opts.okLabel ?? "OK");
  const cancelLabel =
    dialog.kind === "confirm" ? (dialog.opts.cancelLabel ?? "Cancel") : null;

  return (
    <div
      className="overlay-backdrop"
      onClick={() => closeDialog(dialog.id, false)}
    >
      <div
        className="modal modal--dialog"
        role="alertdialog"
        aria-label={dialog.opts.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__title">{dialog.opts.title}</div>
        <div className="dialog__message">{dialog.opts.message}</div>
        <div className="modal__actions">
          {cancelLabel !== null && (
            <button
              className="modal__cancel"
              onClick={() => closeDialog(dialog.id, false)}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={primaryRef}
            className={`modal__create${danger ? " modal__create--danger" : ""}`}
            onClick={() => closeDialog(dialog.id, true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A question with more than two answers: each choice is its own button on its
 * own row, carrying the consequence of picking it.
 *
 * Stacked rather than a row of peers because the labels are sentences, not
 * verbs, and because a row would rank them by position while saying nothing
 * about what they do. Cancel stays visually apart — it is the answer that
 * changes nothing.
 */
function ChoiceView({
  dialog,
  primaryRef,
  panelRef
}: {
  dialog: Extract<PendingDialog, { kind: "choose" }>;
  primaryRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className="overlay-backdrop"
      onClick={() => closeDialog(dialog.id, false)}
    >
      <div
        ref={panelRef}
        className="modal modal--dialog modal--choice"
        role="alertdialog"
        aria-modal="true"
        aria-label={dialog.opts.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__title">{dialog.opts.title}</div>
        <div className="dialog__message">{dialog.opts.message}</div>
        {dialog.opts.facts !== undefined && dialog.opts.facts.length > 0 && (
          <ul className="dialog__facts">
            {dialog.opts.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        )}
        <div className="dialog__choices">
          {dialog.opts.choices.map((choice, index) => (
            <button
              key={choice.id}
              ref={index === 0 ? primaryRef : undefined}
              className={`dialog__choice${index === 0 ? " is-primary" : ""}${
                choice.danger === true ? " is-danger" : ""
              }`}
              onClick={() => closeDialog(dialog.id, choice.id)}
            >
              <span className="dialog__choice-label">{choice.label}</span>
              {choice.detail !== undefined && (
                <span className="dialog__choice-detail">{choice.detail}</span>
              )}
            </button>
          ))}
        </div>
        <div className="modal__actions">
          <button
            className="modal__cancel"
            onClick={() => closeDialog(dialog.id, false)}
          >
            {dialog.opts.cancelLabel ?? "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
