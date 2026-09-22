import { useId, useRef } from "react";
import { useModal } from "../../lib/useModal";

/**
 * The disclosure shown the first time AI features are turned on for a
 * profile. Ported from PwrSnap's `AiConsentDialog`.
 *
 * It says what leaves the machine and when, in terms that are true today: the
 * one AI feature is rebase review, and #149's review sends commit hashes,
 * subjects and PwrGit's plan — no file contents. A feature that sends more
 * must change this copy before it ships, not after.
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
          A rebase review, the first AI feature, sends the selected commits’ hashes and
          subjects and the plan PwrGit computed. Nothing is sent until you use a feature,
          and you can turn this off from the bottom of the sidebar at any time.
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
