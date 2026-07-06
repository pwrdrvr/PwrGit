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

  useEffect(() => {
    if (dialog === null) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDialog(dialog.id, false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        closeDialog(dialog.id, true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog]);

  if (dialog === null) return null;
  return <DialogView dialog={dialog} primaryRef={primaryRef} />;
}

function DialogView({
  dialog,
  primaryRef
}: {
  dialog: PendingDialog;
  primaryRef: RefObject<HTMLButtonElement | null>;
}) {
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
