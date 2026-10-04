import { useEffect, useRef, useState } from "react";
import {
  forkTrackingRepair,
  isForgeKind,
  parseForgeRemote,
  remoteMatchesForgeRepo,
  routedRemotes,
  trackedRemoteName,
  type Repo,
  type RepoIdentity,
  type RepoRefs,
  type Worktree
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { useForgeHostMap } from "../../lib/useForgeHostMap";
import { RouteStrip, type RouteArrow, type RouteEnd } from "./ForkRoute";
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
  const route = branch === undefined ? null : remotesRoute(currentIdentity, refs, branch, hosts);
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
      {offer !== null
        ? <p>{offer.branch} pulls from and pushes to the original instead of your fork, {currentIdentity?.nameWithOwner ?? "origin"}.</p>
        : <p>{currentIdentity?.parent === undefined
          ? "Re-check origin to recognize an existing fork, including one set up outside PwrGit."
          : route?.lead ?? `${currentIdentity.nameWithOwner} is recognized as a fork.`}</p>}
      {message !== null && <p role="status">{message}</p>}
    </div>
    <div className="refs-remote-card__actions">
      {offer !== null && worktree != null && <button className="is-primary" disabled={busy}
        onClick={() => setReviewing(true)}>Use your fork for {offer.branch}…</button>}
      <button disabled={busy} aria-busy={busy} onClick={() => void recheck()}>{busy ? "Checking…" : "Re-check origin"}</button>
    </div>
    {route !== null && <div className="refs-fork-route"><RouteStrip {...route.strip} /></div>}
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

/**
 * The branch's route as it is now, for the Remotes card: drawn whenever the
 * forge has confirmed `origin` is a fork and the branch follows the fork or
 * its parent, whether or not anything needs repair. Plain arrows, no Now or
 * After — this card changes nothing. The Sync arrow is drawn only where the
 * original's default branch is this branch, since that is what Pull's Sync
 * offers. Design: `design/Fork Route Graphic - UX Review.dc.html`, 4b and 4d.
 */
export function remotesRoute(
  identity: RepoIdentity | undefined,
  refs: Pick<RepoRefs, "remotes">,
  branch: { name: string; upstream?: string },
  hosts: Parameters<typeof routedRemotes>[2]
): { lead: string; strip: Parameters<typeof RouteStrip>[0] } | null {
  if (identity?.parent === undefined) return null;
  const rows = routedRemotes(identity, refs.remotes, hosts);
  const fork = rows.find((row) => row.role === "fork");
  const original = rows.find((row) => row.role === "original");
  if (fork === undefined) return null;
  const tracked = trackedRemoteName(branch.upstream, refs.remotes);
  const followsFork = tracked === fork.name;
  const followsOriginal = original !== undefined && tracked === original.name;
  if (!followsFork && !followsOriginal) return null;
  const parentSlug = original?.nameWithOwner ?? identity.parent.nameWithOwner;
  const forkSlug = fork.nameWithOwner ?? identity.nameWithOwner;
  const originalEnd: RouteEnd = {
    role: "The original",
    slug: parentSlug,
    ...(original === undefined ? { pending: "no remote" } : { remote: original.name })
  };
  const forkEnd: RouteEnd = {
    role: "Your fork",
    slug: forkSlug,
    remote: fork.name,
    ...(fork.canPush === true ? { perm: "yes" as const } : {}),
    ...(followsFork ? {} : { state: "unused" as const })
  };
  if (followsOriginal) {
    return {
      lead: `${branch.name} pulls from and pushes to the original instead of your fork, ${forkSlug}.`,
      strip: {
        branch: branch.name,
        label: `${branch.name} pulls from and pushes to ${parentSlug}. ${forkSlug} is not used.`,
        original: originalEnd,
        fork: forkEnd,
        toOriginal: [{ verb: "push", tone: "plain" }, { verb: "pull", tone: "plain" }],
        toFork: []
      }
    };
  }
  // Sync needs the original to carry this branch. Its default branch does,
  // and so does any fetched branch of the same name; the preview is only a
  // sample, so a branch missing from it proves nothing and draws no arrow.
  const originalRemote = original === undefined
    ? undefined : refs.remotes.find((remote) => remote.name === original.name);
  const syncs = originalRemote !== undefined && (originalRemote.defaultBranch === branch.name ||
    originalRemote.previewBranches.some((row) => row.name === branch.name));
  const toOriginal: RouteArrow[] = syncs ? [{ verb: "sync", tone: "ghost" }] : [];
  return {
    lead: `${branch.name} pulls from and pushes to your fork.${syncs ? " Sync in the Pull menu brings in the original's new work." : ""}`,
    strip: {
      branch: branch.name,
      label: `${branch.name} pulls from and pushes to ${forkSlug}.${syncs ? ` Sync in the Pull menu brings in ${parentSlug}.` : ""}`,
      original: originalEnd,
      fork: forkEnd,
      toOriginal,
      toFork: [{ verb: "push", tone: "plain" }, { verb: "pull", tone: "plain" }]
    }
  };
}
