import { useState } from "react";
import type { Repo } from "@pwrgit/shared";

export function NewWorktreeModal({
  repo,
  onCreate,
  onClose
}: {
  repo: Repo;
  onCreate: (branch: string, newBranch: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (branch.trim() === "") return;
    setBusy(true);
    setError(null);
    const message = await onCreate(branch.trim(), newBranch);
    setBusy(false);
    if (message === null) onClose();
    else setError(message);
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__title">New worktree · {repo.name}</div>
        <input
          className="modal__input"
          autoFocus
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch name"
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            else if (e.key === "Escape") onClose();
          }}
        />
        <label className="modal__check">
          <input
            type="checkbox"
            checked={newBranch}
            onChange={(e) => setNewBranch(e.target.checked)}
          />
          Create as a new branch
        </label>
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
