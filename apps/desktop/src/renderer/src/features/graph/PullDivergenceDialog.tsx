import { useEffect, useRef, useState } from "react";
import type { DivergenceCommit, RemoteDivergence } from "@pwrgit/shared";

type RecoveryAction = "rebase" | "reset" | null;

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function CommitPreview({
  title,
  commits
}: {
  title: string;
  commits: DivergenceCommit[];
}) {
  const shown = commits.slice(0, 3);
  return (
    <section className="pull-divergence__commits">
      <div className="pull-divergence__commits-head">
        <span>{title}</span>
        <span>{countLabel(commits.length)}</span>
      </div>
      <ul>
        {shown.map((commit, index) => (
          <li key={`${commit.shortHash}-${index}`} title={commit.subject}>
            <code>{commit.shortHash}</code>
            <span>{commit.subject || "(no commit message)"}</span>
          </li>
        ))}
      </ul>
      {commits.length > shown.length && (
        <div className="pull-divergence__more">
          +{commits.length - shown.length} more
        </div>
      )}
    </section>
  );
}

/**
 * A focused recovery decision after a fast-forward-only pull detects two
 * histories. It presents the observable state, not a guess about which choice
 * the user should make.
 */
export function PullDivergenceDialog({
  divergence,
  busy,
  onClose,
  onRebase,
  onReset
}: {
  divergence: RemoteDivergence;
  busy: RecoveryAction;
  onClose: () => void;
  onRebase: () => void;
  onReset: () => void;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, [confirmingReset]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy !== null) return;
      if (confirmingReset) setConfirmingReset(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, confirmingReset, onClose]);

  const canRecover = divergence.workingTreeClean && busy === null;
  const localCount = divergence.localCommits.length;

  return (
    <div
      className="overlay-backdrop pull-divergence-backdrop"
      onClick={() => busy === null && onClose()}
    >
      <div
        className="modal pull-divergence"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pull-divergence-title"
        onClick={(event) => event.stopPropagation()}
      >
        {confirmingReset ? (
          <>
            <div className="modal__title" id="pull-divergence-title">
              Reset local branch to remote?
            </div>
            <p className="pull-divergence__intro">
              This moves <code>{divergence.branch}</code> to{" "}
              <code>{divergence.upstream}</code> and removes {countLabel(localCount)}
              {" "}from the local branch. Your working tree is clean. The commits may
              still be recoverable through Git&apos;s reflog, but treat this as a
              destructive change.
            </p>
            <div className="modal__actions">
              <button
                ref={closeRef}
                className="modal__cancel"
                disabled={busy !== null}
                onClick={() => setConfirmingReset(false)}
              >
                Back
              </button>
              <button
                className="modal__create modal__create--danger"
                disabled={busy !== null}
                onClick={onReset}
              >
                {busy === "reset" ? "Resetting…" : "Reset to remote"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal__title" id="pull-divergence-title">
              Branch histories diverged
            </div>
            <p className="pull-divergence__intro">
              <code>{divergence.branch}</code> and <code>{divergence.upstream}</code>
              {" "}each contain commits the other does not. PwrGit stopped before
              changing either history.
            </p>

            <div className="pull-divergence__facts">
              <div>
                <span>Local only</span>
                <strong>{countLabel(divergence.localCommits.length)}</strong>
              </div>
              <div>
                <span>Remote only</span>
                <strong>{countLabel(divergence.upstreamCommits.length)}</strong>
              </div>
              <div>
                <span>Working tree</span>
                <strong
                  className={
                    divergence.workingTreeClean ? "is-clean" : "is-dirty"
                  }
                >
                  {divergence.workingTreeClean ? "Clean" : "Has changes"}
                </strong>
              </div>
            </div>

            {divergence.matchingCommitSubjects && (
              <div className="pull-divergence__signal">
                Both sides have the same number of commits with matching messages.
                That can happen after a remote rebase or force-push.
              </div>
            )}

            <div className="pull-divergence__commit-grid">
              <CommitPreview title="Only on this branch" commits={divergence.localCommits} />
              <CommitPreview
                title={`Only on ${divergence.upstream}`}
                commits={divergence.upstreamCommits}
              />
            </div>

            {!divergence.workingTreeClean && (
              <div className="pull-divergence__warning">
                Commit, stash, or discard the uncommitted changes before choosing a
                recovery action.
              </div>
            )}

            <div className="pull-divergence__options">
              <section>
                <div>
                  <strong>Rebase local commits</strong>
                  <p>
                    Replay the local-only commits on <code>{divergence.upstream}</code>.
                    This keeps their changes when possible, but may stop for conflicts.
                  </p>
                </div>
                <button
                  className="pull-divergence__action"
                  disabled={!canRecover}
                  onClick={onRebase}
                >
                  {busy === "rebase" ? "Rebasing…" : "Rebase local commits"}
                </button>
              </section>
              <section className="pull-divergence__option--danger">
                <div>
                  <strong>Reset local branch to remote</strong>
                  <p>
                    Make this checkout match <code>{divergence.upstream}</code> and
                    discard the local-only commits.
                  </p>
                </div>
                <button
                  className="pull-divergence__action pull-divergence__action--danger"
                  disabled={!canRecover}
                  onClick={() => setConfirmingReset(true)}
                >
                  Reset to remote…
                </button>
              </section>
            </div>

            <div className="modal__actions">
              <button
                ref={closeRef}
                className="modal__cancel"
                disabled={busy !== null}
                onClick={onClose}
              >
                Not now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
