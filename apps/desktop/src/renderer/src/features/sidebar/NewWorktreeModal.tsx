import { useState } from "react";
import type { Repo } from "@pwrgit/shared";
import { useModal } from "../../lib/useModal";

export function NewWorktreeModal({
  repo,
  initialBranch = "",
  initialNewBranch = true,
  startPoint,
  onCreate,
  onClose
}: {
  repo: Repo;
  initialBranch?: string;
  initialNewBranch?: boolean;
  startPoint?: string;
  onCreate: (
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => Promise<string | null>;
  onClose: () => void;
}) {
  const [branch, setBranch] = useState(initialBranch);
  const [newBranch, setNewBranch] = useState(initialNewBranch);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (branch.trim() === "") return;
    setBusy(true);
    setError(null);
    const message = await onCreate(branch.trim(), newBranch, startPoint);
    setBusy(false);
    if (message === null) onClose();
    else setError(message);
  };

  const modalRef = useModal<HTMLDivElement>({ onClose });

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__title">New worktree · {repo.name}</div>
        <input
          className="modal__input"
          autoFocus
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch name"
          onKeyDown={(e) => {
            // Escape is the dialog's, via useModal.
            if (e.key === "Enter") void submit();
          }}
        />
        <label className="modal__check">
          <input
            type="checkbox"
            checked={newBranch}
            disabled={startPoint !== undefined}
            onChange={(e) => setNewBranch(e.target.checked)}
          />
          Create as a new branch
        </label>
        {startPoint !== undefined && (
          <div className="modal__hint">Starting from {startPoint}</div>
        )}
        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            disabled={busy || branch.trim() === ""}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
