import { useEffect, useRef, useState } from "react";
import {
  forkTrackingRepair,
  isForgeKind,
  parseForgeRemote,
  remoteMatchesForgeRepo,
  type Repo,
  type RepoRefs,
  type Worktree
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useForgeHostMap } from "../../lib/useForgeHostMap";
import { ForkRouteLine } from "./ForkRoute";
import { ForkTrackingRecoveryDialog } from "./ForkTrackingRecoveryDialog";

/** Keep the relationship and its repair visible where people edit remotes. */
export function ForkRemoteStatus({ repo, refs, focusedWorktree, onRefresh }: {
  repo: Repo;
  refs: RepoRefs;
  focusedWorktree: Worktree | null;
  onRefresh: () => void | Promise<void>;
}) {
  const hosts = useForgeHostMap();
  const [identity, setIdentity] = useState(repo.identity);
  const [busy, setBusy] = useState(false);
  /** The repair is reviewed in the same dialog Push and Pull open, with its
   *  picture of what changes, rather than applied from here unseen. */
  const [reviewing, setReviewing] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [repaired, setRepaired] = useState<string | null>(null);
  useEffect(() => { setIdentity(repo.identity); }, [repo.identity]);
  const origin = refs.remotes.find((remote) => remote.name === "origin");
  const worktree = (focusedWorktree?.repoId === repo.id && !focusedWorktree.missing
    ? focusedWorktree : null) ?? repo.worktrees.find((row) => row.isPrimary && !row.missing);
  const branch = refs.branches.find((row) => row.name === worktree?.branch);
  const currentIdentity = origin !== undefined && identity !== undefined && remoteMatchesForgeRepo(origin.fetchUrl, identity, hosts) ? identity : undefined;
  const repair = branch === undefined ? null : forkTrackingRepair(currentIdentity, refs.remotes, branch, hosts);
  const offer = repair !== null && `${repair.branch}:${repair.upstream}` === repaired ? null : repair;
  const parsedOrigin = origin === undefined ? null : parseForgeRemote(origin.fetchUrl, hosts);
  if (parsedOrigin === null || !isForgeKind(parsedOrigin.host)) return null;

  const recheck = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await dispatch("repo:refreshIdentities", {
        profileId: repo.profileId, repoId: repo.id, force: true
      });
      if (!result.ok) setMessage(result.error.message);
      else {
        const outcome = result.value.outcomes.find((row) => row.repoId === repo.id);
        if (outcome?.status === "resolved") {
          setIdentity(outcome.identity);
          setMessage(outcome.identity?.parent === undefined
            ? "The forge reports that origin is not a fork."
            : "Fork relationship refreshed.");
        } else {
          setMessage(outcome?.status === "signed_out"
            ? "Sign in in Settings → Forges, then re-check origin."
            : outcome?.status === "host_disabled"
              ? `${outcome.hostname} is switched off in Settings → Forges.`
              : "Could not determine the fork relationship. Check Settings → Forges or Logs, then re-check origin.");
        }
      }
    } catch {
      setMessage("Could not re-check origin. See Logs.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <section className="refs-remote-card refs-fork-parent-offer">
    <div>
      <strong>{currentIdentity?.parent === undefined ? "Fork relationship" : `Fork of ${currentIdentity.parent.nameWithOwner}`}</strong>
      {offer === null
        ? <p>{currentIdentity?.parent === undefined
          ? "Re-check origin to recognize an existing fork, including one set up outside PwrGit."
          : `${currentIdentity.nameWithOwner} is recognized as a fork.`}</p>
        : <>
          <p><ForkRouteLine branch={offer.branch} original={currentIdentity?.parent?.nameWithOwner ?? offer.upstream} /></p>
          <p>{offer.branch} pulls from and pushes to the original instead of your fork, {currentIdentity?.nameWithOwner ?? "origin"}.</p>
        </>}
      {message !== null && <p role="status">{message}</p>}
    </div>
    <div className="refs-remote-card__actions">
      {offer !== null && worktree != null && <button className="is-primary" disabled={busy}
        onClick={() => setReviewing(true)}>Use your fork for {offer.branch}…</button>}
      <button disabled={busy} aria-busy={busy} onClick={() => void recheck()}>{busy ? "Checking…" : "Re-check origin"}</button>
    </div>
    {reviewing && worktree != null && <ForkTrackingRecoveryDialog repo={repo} worktreeId={worktree.id}
      entry={{ from: "remotes" }} onClose={() => setReviewing(false)}
      onRepaired={(done) => {
        setReviewing(false);
        if (offer !== null) setRepaired(`${offer.branch}:${offer.upstream}`);
        setMessage(`${done.branch} now pulls from and pushes to ${done.target.nameWithOwner}. Its commits and files are unchanged.`);
        void onRefresh();
      }} />}
  </section>;
}
