import { useId, useRef, useState } from "react";
import type { PushPublishTarget, RemoteSummary } from "@pwrgit/shared";
import { useModal } from "../../lib/useModal";

/**
 * The remote a branch is offered to first: `origin` when there is one, since
 * that is where a clone's branches go unless someone chose otherwise, and
 * otherwise whichever remote is listed first.
 */
export function defaultPublishRemote(remotes: RemoteSummary[]): string | null {
  return (
    remotes.find((remote) => remote.name === "origin")?.name ??
    remotes[0]?.name ??
    null
  );
}

/**
 * Where to put a branch that is on no remote yet — what the toolbar's Push asks
 * when there is nowhere for a plain push to go.
 *
 * Without it, Push on a new branch was a dead end: Git refused, and the status
 * card relayed Git's advice to go and run `git push --set-upstream origin
 * <branch>` in a terminal. This is that command, with the one question it
 * needs answered put to the user.
 *
 * It asks for the remote and nothing else. The branch keeps its own name there
 * because Git's default `push.default=simple` refuses a plain push whose
 * upstream is named differently — a rename here would publish a branch the
 * Push button could never push to again.
 *
 * The remotes arrive with the dialog rather than after it: the caller loads
 * them before opening, so the list never appears under a dialog the user is
 * already reading.
 */
export function PublishBranchDialog({
  branch,
  remotes,
  onPublish,
  onClose
}: {
  branch: string;
  remotes: RemoteSummary[];
  onPublish: (target: PushPublishTarget) => void;
  onClose: () => void;
}) {
  const [remote, setRemote] = useState(() => defaultPublishRemote(remotes));
  const publishRef = useRef<HTMLButtonElement>(null);
  // Focus lands on Publish, so the common case — the default remote — is one
  // Enter away from the click that opened this.
  const modalRef = useModal<HTMLDivElement>({
    onClose,
    initialFocusRef: publishRef
  });
  const titleId = useId();
  const listId = useId();

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="modal publish-branch"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id={titleId}>
          Publish {branch}
        </div>
        <p className="publish-branch__lede">
          This branch isn’t on any remote yet. Publishing pushes it and tracks
          it there, so Push works on its own from then on.
        </p>

        {remotes.length === 0 ? (
          <p className="modal__error">
            This repository has no remotes to publish to. Add one under Remotes
            in the sidebar, then try again.
          </p>
        ) : (
          <div
            className="refs-destinations"
            role="radiogroup"
            aria-labelledby={listId}
          >
            <div className="refs-field__label" id={listId}>
              Remote
            </div>
            {remotes.map((candidate) => (
              <label className="refs-destination" key={candidate.name}>
                <input
                  type="radio"
                  name="publish-remote"
                  checked={remote === candidate.name}
                  onChange={() => setRemote(candidate.name)}
                />
                <span className="refs-destination__name">{candidate.name}</span>
                <span className="refs-destination__url">{candidate.pushUrl}</span>
              </label>
            ))}
          </div>
        )}

        {remote !== null && (
          <div className="modal__hint">
            Pushes {branch} to {remote}/{branch} and tracks it.
          </div>
        )}

        <div className="modal__actions">
          <button className="modal__cancel" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={publishRef}
            className="modal__create"
            type="button"
            disabled={remote === null}
            onClick={() => {
              if (remote !== null) onPublish({ remote });
            }}
          >
            Publish
          </button>
        </div>
      </div>
    </div>
  );
}
