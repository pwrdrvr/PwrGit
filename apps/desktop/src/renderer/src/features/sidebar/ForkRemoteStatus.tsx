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

/** Keep the relationship and its repair visible where people edit remotes. */
export function ForkRemoteStatus({ repo, refs, focusedWorktree, onRefresh }: {
  repo: Repo;
  refs: RepoRefs;
  focusedWorktree: Worktree | null;
  onRefresh: () => void | Promise<void>;
}) {
  const hosts = useForgeHostMap();
  const [identity, setIdentity] = useState(repo.identity);
  const [busy, setBusy] = useState<"refresh" | "repair" | null>(null);
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

  const run = async (kind: "refresh" | "repair"): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "repair" && offer !== null && worktree !== undefined && worktree !== null) {
        const result = await dispatch("remote:repairForkTracking", {
          worktreeId: worktree.id, branch: offer.branch, upstream: offer.upstream
        });
        if (!result.ok) setMessage(result.error.message);
        else {
          setRepaired(`${offer.branch}:${offer.upstream}`);
          setMessage(`${offer.branch} now tracks ${offer.target}. Branch commits and files are unchanged.`);
          await onRefresh();
        }
      } else if (kind === "refresh") {
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
      }
    } catch {
      setMessage("Could not update fork tracking. Re-check origin or see Logs.");
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  return <section className="refs-remote-card refs-fork-parent-offer">
    <div>
      <strong>{currentIdentity?.parent === undefined ? "Fork relationship" : `Fork of ${currentIdentity.parent.nameWithOwner}`}</strong>
      {offer === null
        ? <p>{currentIdentity?.parent === undefined
          ? "Re-check origin to recognize an existing fork, including one set up outside PwrGit."
          : `${currentIdentity.nameWithOwner} is recognized as a fork.`}</p>
        : <p>{offer.branch} still tracks {offer.upstream}. Track {offer.target} to pull and push through your fork. This changes tracking only; it does not move commits or push.</p>}
      {message !== null && <p role="status">{message}</p>}
    </div>
    <div className="refs-remote-card__actions">
      {offer !== null && <button disabled={busy !== null} aria-busy={busy === "repair"} onClick={() => void run("repair")}>{busy === "repair" ? "Updating…" : `Track ${offer.target}`}</button>}
      <button disabled={busy !== null} aria-busy={busy === "refresh"} onClick={() => void run("refresh")}>{busy === "refresh" ? "Checking…" : "Re-check origin"}</button>
    </div>
  </section>;
}
