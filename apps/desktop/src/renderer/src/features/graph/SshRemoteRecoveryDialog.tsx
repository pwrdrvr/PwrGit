import { useEffect, useRef, useState } from "react";
import type { RemoteActivityKind, SshRemoteRecovery } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import {
  showErrorToast,
  showInfoToast,
  type ToastSubject
} from "../../lib/toast";
import { useModal } from "../../lib/useModal";

type Busy = "test" | "apply" | null;

/**
 * What the dialog says about the operation Git refused. The test and the
 * change are the same for all three; only the operation to try again, and
 * what the read-only test leaves undone, differ.
 */
const OPERATION_COPY: Record<
  RemoteActivityKind,
  { label: string; refused: string; untested: string }
> = {
  fetch: {
    label: "Fetch",
    refused: "Fetch could not find a usable HTTPS credential.",
    untested: "It does not fetch or update local refs."
  },
  pull: {
    label: "Pull",
    // Checkout-time LFS smudge runs inside a pull and fails the same way.
    refused:
      "Pull—or Git LFS during checkout—could not find a usable HTTPS credential.",
    untested:
      "It does not pull, update local refs, or download Git LFS objects. LFS access is exercised when you choose Pull again."
  },
  push: {
    label: "Push",
    refused: "Push could not find a usable HTTPS credential.",
    untested: "It does not push or update local refs."
  }
};

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

export function SshRemoteRecoveryDialog({
  worktreeId,
  operation,
  recovery,
  onClose,
  onChanged
}: {
  worktreeId: string;
  /** The operation Git refused, which the copy names and never retries. */
  operation: RemoteActivityKind;
  recovery: SshRemoteRecovery;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(true);
  const copy = OPERATION_COPY[operation];

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => primaryRef.current?.focus(), [tested]);

  /** The toast's chips: this checkout's repo and the remote being repaired,
   *  with the URL it is configured with at that moment — still HTTPS until
   *  the change lands. */
  const remoteSubject = (url: string): ToastSubject => ({
    worktreeId,
    remote: { name: recovery.remote, url }
  });

  const test = async (): Promise<void> => {
    setBusy("test");
    setError(null);
    const result = await dispatch("remote:testSshRecovery", {
      worktreeId,
      recovery
    });
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      const message = firstLine(result.error.message);
      setTested(false);
      setError(message);
      showErrorToast({
        title: "SSH test failed",
        message,
        detail: result.error.message,
        subject: remoteSubject(recovery.httpsUrl)
      });
      return;
    }
    setTested(true);
  };

  const apply = async (): Promise<void> => {
    setBusy("apply");
    setError(null);
    const result = await dispatch("remote:applySshRecovery", {
      worktreeId,
      recovery
    });
    if (!activeRef.current) return;
    setBusy(null);
    if (!result.ok) {
      const message = firstLine(result.error.message);
      setError(message);
      showErrorToast({
        title: "Change remote failed",
        message,
        detail: result.error.message,
        subject: remoteSubject(recovery.httpsUrl)
      });
      return;
    }
    showInfoToast({
      title: "Remote changed to SSH",
      message: `${recovery.remote} now uses SSH. ${copy.label} again when you are ready.`,
      subject: remoteSubject(recovery.sshUrl)
    });
    onChanged();
  };

  // Escape is refused while a test or repair is in flight — the same rule the
  // hand-rolled handler applied before this moved to the shared hook.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (busy === null) onClose();
    }
  });

  return (
    <div
      className="overlay-backdrop ssh-recovery-backdrop"
      onClick={() => busy === null && onClose()}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="modal ssh-recovery"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-recovery-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id="ssh-recovery-title">
          Try this remote with SSH?
        </div>
        <p className="ssh-recovery__intro">
          {copy.refused} The tracked remote <code>{recovery.remote}</code>{" "}
          points to GitHub over HTTPS. PwrGit can test the equivalent SSH
          address without fetching or changing this repository.
        </p>
        <dl className="ssh-recovery__urls">
          <div>
            <dt>Current</dt>
            <dd><code>{recovery.httpsUrl}</code></dd>
          </div>
          <div>
            <dt>SSH</dt>
            <dd><code>{recovery.sshUrl}</code></dd>
          </div>
        </dl>
        <p className="ssh-recovery__note">
          The test checks Git read access only. {copy.untested}
        </p>
        {recovery.pushUrlWillAlsoChange ? (
          <p className="ssh-recovery__note">
            Changing this remote to SSH will also change the address Git uses
            for pushes. The read-only test does not verify push permission.
          </p>
        ) : (
          <p className="ssh-recovery__note">
            A separate push URL is configured and will remain unchanged.
          </p>
        )}
        {tested && (
          <p className="ssh-recovery__success" role="status">
            SSH can read this repository. You can now change the fetch URL
            {recovery.pushUrlWillAlsoChange && " and effective push URL"};
            PwrGit will not retry {copy.label} automatically.
          </p>
        )}
        {error !== null && <p className="ssh-recovery__error">{error}</p>}
        <div className="modal__actions ssh-recovery__actions">
          <button
            className="modal__cancel"
            disabled={busy !== null}
            onClick={onClose}
          >
            Not now
          </button>
          {tested && (
            <button
              className="modal__cancel"
              disabled={busy !== null}
              onClick={() => void test()}
            >
              {busy === "test" ? "Testing…" : "Test again"}
            </button>
          )}
          <button
            ref={primaryRef}
            className="modal__create"
            disabled={busy !== null}
            onClick={() => void (tested ? apply() : test())}
          >
            {busy === "test"
              ? "Testing SSH…"
              : busy === "apply"
                ? "Changing remote…"
                : tested
                  ? `Change ${recovery.remote} to SSH`
                  : "Test SSH connection"}
          </button>
        </div>
      </div>
    </div>
  );
}
