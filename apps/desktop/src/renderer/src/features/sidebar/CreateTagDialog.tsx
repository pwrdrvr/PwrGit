import { useState } from "react";
import type { Repo, TagSummary } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";

const explicitCommit = (value: string): boolean => /^[0-9a-f]{7,64}$/i.test(value);

export function CreateTagDialog({
  repo,
  onCreated,
  onClose
}: {
  repo: Repo;
  onCreated: (tag: TagSummary) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [targetCommit, setTargetCommit] = useState("");
  const [kind, setKind] = useState<"lightweight" | "annotated">("lightweight");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targetCommit.trim();
  const valid =
    name.trim() !== "" &&
    explicitCommit(target) &&
    (kind === "lightweight" || message.trim() !== "");

  const create = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const result = await dispatch("tag:create", {
      repoId: repo.id,
      name: name.trim(),
      targetCommit: target,
      kind,
      ...(kind === "annotated" ? { message: message.trim() } : {})
    });
    setBusy(false);
    if (!result.ok) {
      const summary = result.error.message.split("\n")[0];
      setError(summary);
      showErrorToast({
        title: "Create tag failed",
        message: summary,
        detail: result.error.message
      });
      return;
    }
    showInfoToast({
      title: "Tag created",
      message: `${result.value.name} points to ${result.value.targetId.slice(0, 12)}.`
    });
    onCreated(result.value);
    onClose();
  };

  return (
    <div className="overlay-backdrop refs-push-backdrop" onClick={onClose}>
      <div
        className="modal refs-tag-dialog"
        role="dialog"
        aria-label={`Create tag in ${repo.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">Create tag · {repo.name}</div>
        <label className="refs-field">
          <span>Tag name</span>
          <input
            autoFocus
            aria-label="Tag name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="v1.2.0"
          />
        </label>
        <label className="refs-field">
          <span>Target commit</span>
          <input
            aria-label="Target commit"
            value={targetCommit}
            onChange={(event) => setTargetCommit(event.target.value)}
            placeholder="full or unambiguous commit ID"
          />
        </label>
        <label className="refs-field">
          <span>Tag kind</span>
          <select
            aria-label="Tag kind"
            value={kind}
            onChange={(event) => {
              const value = event.target.value;
              setKind(value === "annotated" ? "annotated" : "lightweight");
            }}
          >
            <option value="lightweight">Lightweight</option>
            <option value="annotated">Annotated</option>
          </select>
        </label>
        {kind === "annotated" && (
          <label className="refs-field refs-field--message">
            <span>Annotation</span>
            <textarea
              aria-label="Annotation"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Release notes or tag message"
            />
          </label>
        )}
        <div className="modal__hint">
          Tags are repository refs, not branches. Creating one never switches a
          worktree. Supply the exact commit you intend to mark.
        </div>
        {target !== "" && !explicitCommit(target) && (
          <div className="modal__error">
            Enter a full or unambiguous commit object ID, not a branch name.
          </div>
        )}
        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal__create"
            disabled={!valid || busy}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create tag"}
          </button>
        </div>
      </div>
    </div>
  );
}
