import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteBranchSummary,
  RemoteResetMode,
  RemoteResetSnapshot,
  RepoRefs,
  Worktree
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";

type Busy = "load" | "review" | "reset" | null;

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function shortHead(head: string): string {
  return head.slice(0, 12);
}

export function resetInspectionRequest(worktreeId: string, remoteRef: string) {
  return { worktreeId, remoteRef };
}

export function resetExecutionRequest(
  worktreeId: string,
  mode: RemoteResetMode,
  snapshot: RemoteResetSnapshot
) {
  return { worktreeId, mode, ...snapshot };
}

export function ResetToRemoteDialog({
  worktree,
  onClose,
  onComplete
}: {
  worktree: Worktree;
  onClose: () => void;
  onComplete: (mode: RemoteResetMode, branch: string) => void;
}) {
  const [refs, setRefs] = useState<RepoRefs | null>(null);
  const [selectedRef, setSelectedRef] = useState("");
  const [mode, setMode] = useState<RemoteResetMode>("soft");
  const [review, setReview] = useState<RemoteResetSnapshot | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);

  const branches = useMemo(
    () => refs?.remotes.flatMap((remote) => remote.branches) ?? [],
    [refs]
  );
  const selected = branches.find((branch) => branch.fullName === selectedRef);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void dispatch("repo:refs", { repoId: worktree.repoId }).then((result) => {
      if (!active) return;
      setBusy(null);
      if (!result.ok) {
        const message = firstLine(result.error.message);
        setError(message);
        showErrorToast({
          title: "Load remote branches failed",
          message,
          detail: result.error.message
        });
        return;
      }
      setRefs(result.value);
      setSelectedRef(result.value.remotes[0]?.branches[0]?.fullName ?? "");
    });
    return () => {
      active = false;
    };
  }, [worktree.repoId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy !== null) return;
      if (review !== null) setReview(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, review]);

  const changeMode = (next: RemoteResetMode): void => {
    setMode(next);
    setReview(null);
    setError(null);
  };

  const inspect = async (): Promise<void> => {
    if (selected === undefined) return;
    setBusy("review");
    setError(null);
    const result = await dispatch(
      "remote:inspectReset",
      resetInspectionRequest(worktree.id, selected.fullName)
    );
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      const message = firstLine(result.error.message);
      setError(message);
      showErrorToast({
        title: "Review reset failed",
        message,
        detail: result.error.message
      });
      return;
    }
    setReview(result.value);
  };

  const reset = async (): Promise<void> => {
    if (review === null || selected === undefined) return;
    setBusy("reset");
    setError(null);
    const result = await dispatch(
      "remote:resetToRemote",
      resetExecutionRequest(worktree.id, mode, review)
    );
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      const message = firstLine(result.error.message);
      setError(message);
      setReview(null);
      showErrorToast({
        title: `${mode === "hard" ? "Hard" : "Soft"} reset failed`,
        message,
        detail: result.error.message
      });
      return;
    }
    showInfoToast({
      title: `${mode === "hard" ? "Hard" : "Soft"} reset complete`,
      message: `${review.branch} now points to ${selected.qualifiedName} at ${shortHead(review.remoteHead)}.`
    });
    onComplete(mode, selected.qualifiedName);
    onClose();
  };

  const canClose = busy === null;
  const targetLabel = selected?.qualifiedName ?? review?.remoteRef ?? "remote branch";

  return (
    <div
      className="overlay-backdrop reset-remote-backdrop"
      onClick={() => canClose && onClose()}
    >
      <div
        className="modal reset-remote"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-remote-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id="reset-remote-title">
          Reset {worktree.branch} to a fetched remote branch
        </div>

        {review === null ? (
          <>
            <p className="reset-remote__intro">
              Choose the fetched remote-tracking tip that this checked-out local
              branch should point to. PwrGit will inspect both tips again before
              showing the final confirmation.
            </p>

            <label className="refs-field reset-remote__target">
              <span>Remote branch</span>
              <select
                autoFocus
                value={selectedRef}
                disabled={busy !== null || branches.length === 0}
                onChange={(event) => {
                  setSelectedRef(event.target.value);
                  setReview(null);
                  setError(null);
                }}
              >
                {branches.map((branch: RemoteBranchSummary) => (
                  <option key={branch.fullName} value={branch.fullName}>
                    {branch.qualifiedName} · {shortHead(branch.head)}
                  </option>
                ))}
              </select>
            </label>

            {busy === "load" && (
              <div className="reset-remote__empty">Loading fetched branches…</div>
            )}
            {busy !== "load" && refs !== null && branches.length === 0 && (
              <div className="reset-remote__empty">
                No fetched remote branches are available. Fetch a remote first.
              </div>
            )}

            <fieldset className="reset-remote__modes">
              <legend>Reset mode</legend>
              <label className={mode === "soft" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="reset-mode"
                  value="soft"
                  checked={mode === "soft"}
                  onChange={() => changeMode("soft")}
                />
                <span>
                  <strong>Soft</strong>
                  <small>
                    Move the branch and HEAD to the selected commit without
                    changing the index or working tree. File contents and existing
                    staged/unstaged work stay in place; Git reports their differences
                    against the new HEAD.
                  </small>
                </span>
              </label>
              <label className={mode === "hard" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="reset-mode"
                  value="hard"
                  checked={mode === "hard"}
                  onChange={() => changeMode("hard")}
                />
                <span>
                  <strong>Hard · destructive</strong>
                  <small>
                    Move the branch and HEAD, reset the index, and overwrite tracked
                    files. This discards tracked staged and unstaged changes. Untracked
                    and ignored files are normally left alone, but Git may delete an
                    untracked file or directory that obstructs a tracked path in the
                    target commit. This does not run git clean.
                  </small>
                </span>
              </label>
            </fieldset>

            <p className="reset-remote__history-note">
              Both modes move the local branch pointer to <code>{targetLabel}</code>.
              Any local commits that are not reachable from that target leave the
              branch. Git&apos;s reflog may retain them temporarily; do not rely on that
              as a backup.
            </p>
          </>
        ) : (
          <>
            <p className="reset-remote__intro">
              Review the exact refs and object IDs. The reset will stop if either the
              checkout or fetched remote-tracking ref changes.
            </p>
            <dl className="reset-remote__review">
              <div>
                <dt>Checked-out branch</dt>
                <dd>{review.branch}</dd>
                <dd className="reset-remote__sha">{review.head}</dd>
              </div>
              <div>
                <dt>Fetched target</dt>
                <dd>{targetLabel}</dd>
                <dd className="reset-remote__sha">{review.remoteHead}</dd>
              </div>
            </dl>
            <div
              className={`reset-remote__final-warning${
                mode === "hard" ? " is-hard" : ""
              }`}
            >
              {mode === "hard"
                ? "Hard reset will move the branch pointer to this target and discard tracked staged and unstaged changes. Local commits not reachable from the target will leave the branch. Untracked and ignored files follow Git reset --hard behavior described on the previous screen."
                : "Soft reset will move the branch pointer to this target while leaving the index and working tree unchanged. Local commits not reachable from the target will leave the branch."}
            </div>
          </>
        )}

        {error !== null && <div className="modal__error">{error}</div>}
        <div className="modal__actions">
          {review !== null && (
            <button
              className="modal__cancel"
              disabled={busy !== null}
              onClick={() => setReview(null)}
            >
              Back
            </button>
          )}
          <button className="modal__cancel" disabled={!canClose} onClick={onClose}>
            Cancel
          </button>
          {review === null ? (
            <button
              className="modal__create"
              disabled={busy !== null || selected === undefined}
              onClick={() => void inspect()}
            >
              {busy === "review"
                ? "Inspecting…"
                : `Review ${mode} reset`}
            </button>
          ) : (
            <button
              className={`modal__create${
                mode === "hard" ? " modal__create--danger" : ""
              }`}
              disabled={busy !== null}
              onClick={() => void reset()}
            >
              {busy === "reset"
                ? "Resetting…"
                : `${mode === "hard" ? "Hard" : "Soft"} reset branch`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
