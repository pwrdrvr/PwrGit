import { useEffect, useRef, useState } from "react";
import type { ForkTrackingRepair, Repo } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import { ForkCheckoutDialog } from "./ForkCheckoutDialog";
import { GitForkIcon } from "./RepoIdentityMarks";

/** A denied push may target the parent even though origin is already the
 *  user's fork. Offer tracking repair before asking them to fork again. */
export function ForkTrackingRecoveryDialog({
  repo, worktreeId, reason, onForked, onRepaired, onClose
}: {
  repo: Pick<Repo, "id" | "profileId" | "name" | "identity">;
  worktreeId: string;
  reason: string;
  onForked: (repo: Repo) => void;
  onRepaired: () => void;
  onClose: () => void;
}) {
  const [checking, setChecking] = useState(true);
  const [repair, setRepair] = useState<ForkTrackingRepair | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let active = true;
    setChecking(true);
    setError(null);
    void (async () => {
      // This also recognizes forks that predate PwrGit and remote changes
      // made outside the app. A failed forge read may retain known metadata;
      // main still checks the current Git URLs before proposing a repair.
      await dispatch("repo:refreshIdentities", {
        profileId: repo.profileId, repoId: repo.id, force: true
      });
      if (!active) return;
      const result = await dispatch("remote:inspectForkTracking", { worktreeId });
      if (!active) return;
      if (result.ok) setRepair(result.value);
      else setError(result.error.message);
      setChecking(false);
    })().catch(() => {
      if (!active) return;
      setChecking(false);
      setError("Could not check fork tracking. Re-check or see Logs.");
    });
    return () => { active = false; };
  }, [repo.id, repo.profileId, worktreeId, epoch]);

  const apply = async (): Promise<void> => {
    if (repair === null || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch("remote:repairForkTracking", {
        worktreeId, branch: repair.branch, upstream: repair.upstream
      });
      if (result.ok) onRepaired();
      else setError(result.error.message);
    } catch {
      setError("Could not repair fork tracking. Re-check or see Logs.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!checking && repair === null && error === null) return <ForkCheckoutDialog
    profileId={repo.profileId} repoId={repo.id}
    repoName={repo.identity?.nameWithOwner ?? repo.name}
    reason={reason} onForked={onForked} onClose={onClose}
  />;

  return <ForkTrackingRecoveryPanel checking={checking} repair={repair} error={error}
    busy={busy} reason={reason} onClose={onClose} onApply={() => void apply()}
    onRecheck={() => setEpoch((value) => value + 1)} />;
}

function ForkTrackingRecoveryPanel({ checking, repair, error, busy, reason, onClose, onApply, onRecheck }: {
  checking: boolean;
  repair: ForkTrackingRepair | null;
  error: string | null;
  busy: boolean;
  reason: string;
  onClose: () => void;
  onApply: () => void;
  onRecheck: () => void;
}) {
  const modalRef = useModal<HTMLDivElement>({ onClose: () => { if (!busy) onClose(); } });
  return <div className="overlay-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <div ref={modalRef} className="overlay-panel clone-dialog fork-checkout-dialog"
      role="dialog" aria-modal="true" aria-label="Set up fork tracking"
      onClick={(event) => event.stopPropagation()}>
      <div className="clone-dialog__title">
        <span className="clone-dialog__icon"><GitForkIcon size={17} /></span>
        <span><strong>{repair === null ? "Check fork tracking" : "Use your existing fork"}</strong>
          <small>{checking ? "Checking origin and branch tracking…" : "Repair tracking in this checkout"}</small></span>
        <button className="clone-dialog__close" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
      </div>
      <div className="clone-dialog__body">
        <div className="clone-note fork-checkout-reason">{reason}</div>
        {repair !== null && <section className="clone-section">
          <p>Origin already points at your fork. {repair.branch} still tracks {repair.upstream} instead of {repair.target}.</p>
          <p>Track {repair.target} to use your fork for Pull and Push. This changes tracking only. Your commits and files stay in place; nothing is pushed.</p>
        </section>}
        {error !== null && <div className="clone-submit-error" role="alert">{error}</div>}
      </div>
      <div className="clone-dialog__foot">
        <span className="clone-dialog__spacer" />
        <button className="modal__cancel" disabled={busy} onClick={onClose}>Cancel</button>
        {error !== null && <button className="modal__cancel" disabled={busy} onClick={onRecheck}>Re-check</button>}
        {repair !== null && <button className="modal__create clone-dialog__submit" disabled={busy || checking} onClick={onApply}>
          {busy ? "Updating tracking…" : `Track ${repair.target}`}
        </button>}
      </div>
    </div>
  </div>;
}
