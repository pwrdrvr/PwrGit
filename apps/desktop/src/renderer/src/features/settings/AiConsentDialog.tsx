import { useId, useRef } from "react";
import { useModal } from "../../lib/useModal";

/**
 * The disclosure shown the first time AI features are turned on for a
 * profile. Ported from PwrSnap's `AiConsentDialog`.
 *
 * It says what leaves the machine and when, in terms that are true today, and
 * it has to stay that way: `main/ai/agent-input.ts` builds everything a job
 * sends, and a change there that widens it must change this copy in the same
 * commit, not after. Today that is the staged diff for a commit message, and
 * the selected commits' subjects, bodies and diffs for Squash and Tidy — cut
 * to a line budget, with lockfiles, snapshots, binaries, keys and `.env` files
 * never sent — plus recent subjects as a style sample.
 *
 * Consent is not re-asked when this copy changes (see `main/ai/AGENTS.md`), so
 * it describes the widest thing any shipped feature sends, not the first one.
 *
 * Cancel is the default focus: the dialog exists so that turning AI on is a
 * decision, and Enter on an unread dialog should not make it.
 *
 * Rendered in place, from the sidebar footer as from the Settings card, the
 * way every other dialog in this app is: `.overlay-backdrop` is `position:
 * fixed`, which the sidebar pane does not confine — measured, because
 * `container-type: inline-size` reads as though it would.
 */
export function AiConsentDialog(props: {
  profileName: string;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const modalRef = useModal<HTMLDivElement>({ onClose: props.onCancel, initialFocusRef: cancelRef });

  return (
    <div className="overlay-backdrop" onClick={props.onCancel}>
      <div
        ref={modalRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal modal--dialog ai-consent"
        role="dialog"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="ai-consent__eyebrow">AI features</p>
        <div className="modal__title" id={titleId}>
          Turn on AI features for {props.profileName}?
        </div>
        <p className="dialog__message">
          When you use an AI feature, PwrGit sends what that feature needs to the agent set
          up under Settings → AI Providers — Codex unless you chose another. The agent runs
          on this machine under your own account and may send it on to its provider’s
          service.
        </p>
        <p className="dialog__message">
          Drafting a commit message sends your staged changes — never unstaged edits.
          Squash and Tidy send the selected commits’ subjects, messages and changes.
          Changes are cut to a size limit, and lockfiles, snapshots, binary files, keys
          and <code>.env</code> files are never sent. Recent commit subjects go along so a
          draft matches your repository’s style, and Details, under every draft, lists
          exactly what was sent.
        </p>
        <p className="dialog__message">
          The agent gets no tools and no access to your repository, and PwrGit checks every
          history change itself before you apply it. Nothing is sent until you use a
          feature, and you can turn this off from the bottom of the sidebar at any time.
        </p>
        <div className="modal__actions">
          <button ref={cancelRef} className="modal__cancel" type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="modal__create" type="button" onClick={props.onAccept}>
            Turn on AI features
          </button>
        </div>
      </div>
    </div>
  );
}
