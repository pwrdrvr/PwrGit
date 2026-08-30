import { useState } from "react";
import type {
  RemoteSummary,
  RemoteTagAction,
  RemoteTagPlan,
  RemoteTagResult,
  Repo,
  TagSummary
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { CopyTarget } from "../shell/CopyTarget";

const shortObject = (value: string | undefined): string =>
  value === undefined ? "absent" : value.slice(0, 12);

/** The plan status as a phrase, not the enum the protocol happens to use. */
const statusLabel = (plan: RemoteTagPlan): string => {
  switch (plan.status) {
    case "create":
      return "new on remote";
    case "equal":
      return "already there";
    case "delete":
      return "removing";
  }
};

export function TagRemoteDialog({
  repo,
  tag,
  remotes,
  onCompleted,
  onClose
}: {
  repo: Repo;
  tag: TagSummary;
  remotes: RemoteSummary[];
  onCompleted: (result: RemoteTagResult) => void;
  onClose: () => void;
}) {
  const [remote, setRemote] = useState(remotes[0]?.name ?? "");
  const [action, setAction] = useState<RemoteTagAction>("push");
  const [plan, setPlan] = useState<RemoteTagPlan | null>(null);
  const [result, setResult] = useState<RemoteTagResult | null>(null);
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const edit = (): void => {
    setPlan(null);
    setResult(null);
    setError(null);
  };

  const review = async (): Promise<void> => {
    if (remote === "" || busy !== null) return;
    setBusy("review");
    setError(null);
    const reviewed = await dispatch("tag:planRemote", {
      repoId: repo.id,
      name: tag.name,
      remote,
      action
    });
    setBusy(null);
    if (!reviewed.ok) {
      setError(reviewed.error.message.split("\n")[0]);
      return;
    }
    setPlan(reviewed.value);
  };

  const apply = async (): Promise<void> => {
    if (plan === null || plan.status === "equal" || busy !== null) return;
    setBusy("apply");
    setError(null);
    const applied = await dispatch("tag:applyRemote", {
      repoId: repo.id,
      plan
    });
    setBusy(null);
    if (!applied.ok) {
      const summary = applied.error.message.split("\n")[0];
      setError(summary);
      showErrorToast({
        title: "Remote tag action failed",
        message: summary,
        detail: applied.error.message
      });
      return;
    }
    setResult(applied.value);
    showInfoToast({
      title: applied.value.outcome === "deleted" ? "Remote tag deleted" : "Tag pushed",
      message: `${applied.value.remote}/${applied.value.tagName}`
    });
    onCompleted(applied.value);
  };

  const actionable = plan !== null && plan.status !== "equal";
  return (
    <div className="overlay-backdrop refs-push-backdrop" onClick={onClose}>
      <div
        className="modal refs-tag-dialog"
        role="dialog"
        aria-label={`Manage remote tag ${tag.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">Remote tag · {tag.name}</div>
        {plan === null && result === null && (
          <>
            <label className="refs-field">
              <span>Action</span>
              <select
                aria-label="Remote tag action"
                value={action}
                onChange={(event) => {
                  setAction(event.target.value === "delete" ? "delete" : "push");
                  edit();
                }}
              >
                <option value="push">Push local tag</option>
                <option value="delete">Delete remote tag</option>
              </select>
            </label>
            <label className="refs-field">
              <span>Remote</span>
              <select
                aria-label="Remote"
                value={remote}
                onChange={(event) => {
                  setRemote(event.target.value);
                  edit();
                }}
              >
                {remotes.map((candidate) => (
                  <option value={candidate.name} key={candidate.name}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal__hint">
              Review fetches this exact tag from the selected remote. PwrGit never
              overwrites a remote tag; deletion is a separate leased action.
            </div>
          </>
        )}

        {plan !== null && result === null && (
          <div className="refs-plan" aria-label="Remote tag review">
            <div className="refs-plan__notice">
              <span>{plan.action === "delete" ? "Delete" : "Push"}</span>
              <CopyTarget
                value={`${plan.remote}/${plan.tagName}`}
                label={`Copy remote tag ${plan.remote}/${plan.tagName}`}
                hint={`${plan.fullName}\nClick to copy remote tag`}
                className="refs-plan__copy copyable"
              >
                {plan.remote}/{plan.tagName}
              </CopyTarget>
              <code>{statusLabel(plan)}</code>
              <small>
                Local object {shortObject(plan.localObjectId)} · remote object{" "}
                {shortObject(plan.remoteObjectId)} · target{" "}
                {shortObject(plan.localTargetId ?? plan.remoteTargetId)}
              </small>
              <small title={plan.pushUrl}>Push endpoint {plan.pushUrl}</small>
            </div>
            <div className="refs-plan__hint">
              {plan.status === "create"
                ? "The remote tag was absent at review. Creation uses a lease that requires it to remain absent."
                : plan.status === "equal"
                  ? "The remote already stores this exact tag object. Nothing will be pushed."
                  : "Deletion uses a lease requiring the remote tag to remain exactly the object shown above."}
            </div>
          </div>
        )}

        {result !== null && (
          <div className="refs-plan" role="status">
            <div className={`refs-plan__row refs-plan__row--${result.outcome}`}>
              <span>
                {result.remote}/{result.tagName}
              </span>
              <span>{result.outcome.replaceAll("_", " ")}</span>
            </div>
          </div>
        )}

        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          <button className="modal__cancel" onClick={onClose}>
            {result === null ? "Cancel" : "Close"}
          </button>
          {plan === null && result === null && (
            <button
              className="modal__create"
              disabled={remote === "" || busy !== null}
              onClick={() => void review()}
            >
              {busy === "review" ? "Reading remote…" : "Review action"}
            </button>
          )}
          {plan !== null && result === null && (
            <>
              <button className="modal__cancel" onClick={edit}>
                Edit
              </button>
              <button
                className={`modal__create${plan.action === "delete" ? " modal__create--danger" : ""}`}
                disabled={!actionable || busy !== null}
                onClick={() => void apply()}
              >
                {busy === "apply"
                  ? "Applying…"
                  : plan.status === "equal"
                    ? "Already pushed"
                    : plan.action === "delete"
                      ? "Delete remote tag"
                      : "Push tag"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
