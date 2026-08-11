import { useEffect, useRef, useState } from "react";
import type { SshRemoteRecovery } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";

type Busy = "test" | "apply" | null;

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

export function SshRemoteRecoveryDialog({
  worktreeId,
  recovery,
  onClose,
  onChanged
}: {
  worktreeId: string;
  recovery: SshRemoteRecovery;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => primaryRef.current?.focus(), [tested]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && busy === null) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

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
        detail: result.error.message
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
        detail: result.error.message
      });
      return;
    }
    showInfoToast({
      title: "Remote changed to SSH",
      message: `${recovery.remote} now uses SSH. Pull again when you are ready.`
    });
    onChanged();
  };

  return (
    <div
      className="overlay-backdrop ssh-recovery-backdrop"
      onClick={() => busy === null && onClose()}
    >
      <div
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
          Pull could not find a usable HTTPS credential. The tracked remote{" "}
          <code>{recovery.remote}</code> points to GitHub over HTTPS. PwrGit can
          test the equivalent SSH address without fetching or changing this
          repository.
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
          The test checks Git read access only. It does not pull, update local
          refs, or download Git LFS objects. LFS access is exercised when you
          choose Pull again.
        </p>
        {!recovery.pushUrlWillAlsoChange && (
          <p className="ssh-recovery__note">
            A separate push URL is configured and will remain unchanged.
          </p>
        )}
        {tested && (
          <p className="ssh-recovery__success" role="status">
            SSH can read this repository. You can now change the fetch URL;
            PwrGit will not retry Pull automatically.
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
