import { useEffect, useRef, useState } from "react";
import {
  forgeProductOrAssumed,
  type ForkTrackingOffer,
  type ForkTrackingTarget,
  type Repo
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import { ForkCheckoutDialog } from "./ForkCheckoutDialog";
import { ForkRoute, type RouteRepo } from "./ForkRoute";
import { GitForkIcon } from "./RepoIdentityMarks";

/** Where the dialog was opened. Only a refused push proves the original is
 *  closed to you, so only that entry says so. */
export type ForkTrackingEntry =
  | { from: "push"; error: string }
  | { from: "pull" }
  | { from: "remotes" };

/** What changed, for the receipt the caller shows. */
export type ForkTrackingDone = {
  branch: string;
  parent: string;
  target: ForkTrackingTarget;
};

/** A branch can be left pulling from and pushing to the original even though
 *  origin is already the user's fork — a remote rename carries tracking with
 *  it. Draw where it goes now and where it would go, and move it. */
export function ForkTrackingRecoveryDialog({
  repo, worktreeId, entry, onForked, onRepaired, onClose
}: {
  repo: Pick<Repo, "id" | "profileId" | "name" | "identity">;
  worktreeId: string;
  entry: ForkTrackingEntry;
  /** After a refused push with nothing to repair, the dialog becomes the
   *  offer to fork instead. */
  onForked?: (repo: Repo) => void;
  onRepaired: (done: ForkTrackingDone) => void;
  onClose: () => void;
}) {
  const [checking, setChecking] = useState(true);
  const [offer, setOffer] = useState<ForkTrackingOffer | null>(null);
  const [pick, setPick] = useState(0);
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
      if (result.ok) {
        setOffer(result.value);
        setPick(0);
      } else setError(result.error.message);
      setChecking(false);
    })().catch(() => {
      if (!active) return;
      setChecking(false);
      setError("Could not check fork tracking. Re-check or see Logs.");
    });
    return () => { active = false; };
  }, [repo.id, repo.profileId, worktreeId, epoch]);

  const apply = async (): Promise<void> => {
    const target = offer?.targets[pick];
    if (offer === null || target === undefined || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch("remote:repairForkTracking", {
        worktreeId, branch: offer.branch, upstream: offer.upstream,
        target: { remote: target.remote, nameWithOwner: target.nameWithOwner }
      });
      if (result.ok) onRepaired({ branch: offer.branch, parent: offer.parent, target });
      else setError(result.error.message);
    } catch {
      setError("Could not repair fork tracking. Re-check or see Logs.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (entry.from === "push" && onForked !== undefined && !checking && offer === null && error === null) {
    return <ForkCheckoutDialog
      profileId={repo.profileId} repoId={repo.id}
      repoName={repo.identity?.nameWithOwner ?? repo.name}
      reason={entry.error} onForked={onForked} onClose={onClose}
    />;
  }

  return <ForkTrackingRecoveryPanel repoName={repo.name}
    forge={repo.identity === undefined ? "The forge" : forgeProductOrAssumed(repo.identity.host).label}
    entry={entry} checking={checking} offer={offer} pick={pick} onPick={setPick}
    error={error} busy={busy} onClose={onClose} onApply={() => void apply()}
    onRecheck={() => setEpoch((value) => value + 1)} />;
}

/** "Your fork" for origin; anyone else's fork by its owner. */
function roleOf(target: ForkTrackingTarget): string {
  if (target.remote === "origin") return "Your fork";
  return `${target.nameWithOwner.slice(0, target.nameWithOwner.lastIndexOf("/"))}'s fork`;
}

export function ForkTrackingRecoveryPanel({
  repoName, forge, entry, checking, offer, pick, onPick, error, busy, onClose, onApply, onRecheck
}: {
  repoName: string;
  /** The product's name, for "GitHub refused the push". */
  forge: string;
  entry: ForkTrackingEntry;
  checking: boolean;
  offer: ForkTrackingOffer | null;
  pick: number;
  onPick: (index: number) => void;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
  onRecheck: () => void;
}) {
  const modalRef = useModal<HTMLDivElement>({ onClose: () => { if (!busy) onClose(); } });
  const refused = entry.from === "push";
  const several = offer !== null && offer.targets.length > 1;
  const chosen = offer?.targets[pick] ?? offer?.targets[0];
  const branch = offer?.branch;
  const title = offer === null || chosen === undefined
    ? "Check fork tracking"
    : refused
      ? (several ? "Push to a fork instead" : "Push to your fork instead")
      : (several ? `Use a fork for ${offer.branch}` : `Use your fork for ${offer.branch}`);
  const lead = offer === null
    ? null
    : refused
      ? <><b>{offer.branch}</b> sends its pushes to <b>the original</b>, which your account can't write to. {several
        ? "These forks will take them."
        : "Your fork is already set up here, so point the branch at it."}</>
      : <><b>{offer.branch}</b> pulls from and pushes to <b>the original</b>. {several
        ? "Forks you can push to are set up here, and the branch uses none of them."
        : "Your fork is set up here, but the branch doesn't use it."}</>;
  const original: RouteRepo | null = offer === null
    ? null
    : { slug: offer.parent, remote: offer.upstreamRemote, role: "The original" };
  const forkNode = (target: ForkTrackingTarget): RouteRepo => ({
    slug: target.nameWithOwner, remote: target.remote, role: roleOf(target)
  });

  return <div className="overlay-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <div ref={modalRef} className="overlay-panel clone-dialog fork-checkout-dialog fork-tracking-dialog"
      role="dialog" aria-modal="true" aria-label={title}
      onClick={(event) => event.stopPropagation()}>
      <div className="clone-dialog__title">
        <span className="clone-dialog__icon"><GitForkIcon size={17} /></span>
        <span><strong>{title}</strong>
          <small>{checking ? "Checking where this branch pulls and pushes…" : `${branch ?? "This branch"} in ${repoName}`}</small></span>
        <button className="clone-dialog__close" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
      </div>
      <div className="clone-dialog__body fork-tracking-dialog__body">
        {refused && <div className="fork-tracking-refused" role="note">
          <span className="fork-tracking-refused__mark" aria-hidden="true">!</span>
          <b>{forge} refused the push</b>
          <span className="fork-tracking-refused__quote">{entry.error.replace(/^(ERROR|remote|fatal):\s*/i, "")}</span>
        </div>}
        {lead !== null && <p className="fork-tracking-dialog__lead">{lead}</p>}
        {offer !== null && original !== null && chosen !== undefined && <>
          {several && <fieldset className="fork-tracking-pick">
            <legend className="clone-label">Push to</legend>
            {/* Scrolls past a handful: an organisation can hold many forks
                of one parent, and the footer must stay on screen. */}
            <div className="fork-tracking-pick__list">
              {offer.targets.map((target, index) => <label key={target.remote}
                className={index === pick ? "fork-tracking-pick__row is-picked" : "fork-tracking-pick__row"}>
                <input type="radio" name="fork-tracking-target" checked={index === pick}
                  disabled={busy} onChange={() => onPick(index)} />
                <span className="fork-tracking-pick__copy">
                  <b>{target.nameWithOwner}</b>
                  <small>{roleOf(target)} · <code>{target.remote}</code></small>
                </span>
                <span className="fork-route__perm fork-route__perm--yes">you can push</span>
              </label>)}
            </div>
          </fieldset>}
          {!several && <ForkRoute phase="now" branch={offer.branch} original={original}
            fork={forkNode(chosen)} refused={refused} />}
          <ForkRoute phase="after" branch={offer.branch} original={original}
            fork={forkNode(chosen)} refused={refused} />
          <p className="fork-tracking-dialog__quiet">Only {offer.branch}'s settings change. Your commits and files stay where they are, and nothing is pushed until you push.</p>
          <details className="fork-tracking-terms">
            <summary>In Git terms</summary>
            <p>Sets {offer.branch}'s upstream to <code>{chosen.ref}</code>, the same as <code>git branch --set-upstream-to={chosen.ref} {offer.branch}</code>. In this checkout <code>{chosen.remote}</code> is {chosen.nameWithOwner} and <code>{offer.upstreamRemote}</code> is {offer.parent}.</p>
          </details>
        </>}
        {!checking && offer === null && error === null && <p className="fork-tracking-dialog__lead">
          Nothing to change: this branch no longer tracks the original, or its remotes changed. Re-check after fetching.
        </p>}
        {error !== null && <div className="clone-submit-error" role="alert">{error}</div>}
      </div>
      <div className="clone-dialog__foot">
        <span className="clone-dialog__spacer" />
        <button className="modal__cancel" disabled={busy} onClick={onClose}>{offer === null && !checking ? "Close" : "Cancel"}</button>
        {(error !== null || (!checking && offer === null)) && <button className="modal__cancel" disabled={busy} onClick={onRecheck}>Re-check</button>}
        {offer !== null && chosen !== undefined && <button className="modal__create clone-dialog__submit" disabled={busy || checking} onClick={onApply}>
          {busy ? "Updating…" : several ? `Use ${chosen.nameWithOwner}` : "Use my fork"}
        </button>}
      </div>
    </div>
  </div>;
}
