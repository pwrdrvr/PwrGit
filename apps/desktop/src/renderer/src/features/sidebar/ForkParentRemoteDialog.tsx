import type { RemoteSummary } from "@pwrgit/shared";
import { useState } from "react";
import { useModal } from "../../lib/useModal";

export function ForkParentRemoteDialog({
  parent,
  suggestedName,
  remotes,
  onAdd,
  onClose
}: {
  parent: string;
  suggestedName: string;
  remotes: readonly RemoteSummary[];
  onAdd: (choice: { name: string; renameExistingTo?: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"another" | "move">("another");
  const [name, setName] = useState(suggestedName);
  const [moveTo, setMoveTo] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const modalRef = useModal<HTMLDivElement>({
    onClose: busy ? () => undefined : onClose
  });
  const occupied = remotes.find((remote) => remote.name === "upstream");
  const chosenName = mode === "move" ? moveTo.trim() : name.trim();
  const available = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(chosenName) &&
    chosenName !== "origin" &&
    !remotes.some((remote) => remote.name === chosenName);

  const save = async (): Promise<void> => {
    if (busy || !available) return;
    setBusy(true);
    let added = false;
    try {
      added = await onAdd(
        mode === "move"
          ? { name: "upstream", renameExistingTo: moveTo.trim() }
          : { name: name.trim() }
      );
    } finally {
      setBusy(false);
    }
    if (added) onClose();
  };

  return (
    <div
      className="overlay-backdrop refs-push-backdrop"
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={modalRef}
        className="modal remote-editor fork-parent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add fork parent remote"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">Add fork parent · {parent}</div>
        <div className="modal__hint">
          The name upstream is in use by {occupied?.fetchUrl}. Choose where to
          keep it.
        </div>
        <label className="fork-parent-choice">
          <input
            type="radio"
            name="fork-parent-mode"
            checked={mode === "another"}
            onChange={() => setMode("another")}
          />
          <span>Use another name</span>
        </label>
        {mode === "another" && (
          <label className="refs-field">
            <span>Parent remote name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        <label className="fork-parent-choice">
          <input
            type="radio"
            name="fork-parent-mode"
            checked={mode === "move"}
            onChange={() => setMode("move")}
          />
          <span>Move current upstream</span>
        </label>
        {mode === "move" && (
          <label className="refs-field">
            <span>Move it to</span>
            <input value={moveTo} onChange={(event) => setMoveTo(event.target.value)} />
          </label>
        )}
        <div className="modal__hint">
          The parent will be added as {mode === "move" ? "upstream" : name.trim() || "…"}.
          Its branches will be fetched.
        </div>
        <div className="modal__actions">
          <button className="modal__cancel" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            disabled={!available}
            aria-disabled={busy || !available}
            aria-busy={busy}
            onClick={() => void save()}
          >
            {busy ? "Adding…" : "Add parent remote"}
          </button>
        </div>
      </div>
    </div>
  );
}
