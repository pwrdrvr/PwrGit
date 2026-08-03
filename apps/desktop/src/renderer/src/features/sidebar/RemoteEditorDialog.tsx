import { useState } from "react";
import type { RemoteSummary, Repo } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

export function RemoteEditorDialog({
  repo,
  remote,
  onSaved,
  onClose
}: {
  repo: Repo;
  remote?: RemoteSummary;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(remote?.name ?? "");
  const [fetchUrl, setFetchUrl] = useState(remote?.fetchUrl ?? "");
  const [pushUrl, setPushUrl] = useState(
    remote !== undefined && remote.pushUrl !== remote.fetchUrl ? remote.pushUrl : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = remote !== undefined;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = editing
      ? await dispatch("remote:update", {
          repoId: repo.id,
          originalName: remote.name,
          name: name.trim(),
          fetchUrl: fetchUrl.trim(),
          ...(pushUrl.trim() === "" ? {} : { pushUrl: pushUrl.trim() })
        })
      : await dispatch("remote:add", {
          repoId: repo.id,
          name: name.trim(),
          fetchUrl: fetchUrl.trim(),
          ...(pushUrl.trim() === "" ? {} : { pushUrl: pushUrl.trim() })
        });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message.split("\n")[0]);
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <div className="overlay-backdrop refs-push-backdrop" onClick={onClose}>
      <div
        className="modal remote-editor"
        role="dialog"
        aria-label={editing ? `Edit remote ${remote.name}` : "Add remote"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">
          {editing ? `Edit remote · ${remote.name}` : `Add remote · ${repo.name}`}
        </div>
        <label className="refs-field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="origin, upstream, mac-tests…"
          />
        </label>
        <label className="refs-field">
          <span>Fetch URL</span>
          <input
            value={fetchUrl}
            onChange={(event) => setFetchUrl(event.target.value)}
            placeholder="git@github.com:owner/repo.git"
          />
        </label>
        <label className="refs-field">
          <span>Push URL</span>
          <input
            value={pushUrl}
            onChange={(event) => setPushUrl(event.target.value)}
            placeholder="Same as fetch URL"
          />
        </label>
        <div className="modal__hint">
          Leave Push URL empty to use the Fetch URL for both directions.
        </div>
        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            disabled={busy || name.trim() === "" || fetchUrl.trim() === ""}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : editing ? "Save remote" : "Add remote"}
          </button>
        </div>
      </div>
    </div>
  );
}
