import {
  err,
  forkTrackingCandidates,
  forkTrackingRepair,
  ok,
  parseForgeRemote,
  type ForgeHostMap,
  type ForkTrackingOffer,
  type ForkTrackingTarget,
  type RepoIdentity,
  type Result
} from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";
import { listRemoteEndpoints } from "./git-service";

/** The offer with `origin` as its only target, and the other remotes that
 *  might join it once the forge confirms them. */
export type ForkTrackingInspection = {
  offer: ForkTrackingOffer;
  candidates: ForkTrackingTarget[];
};

/** Read the actual checked-out branch; a repo row may have changed since the
 *  denied push. No forge or remote network calls are made here — this runs
 *  under the repository lock, so the caller asks the forge about
 *  `candidates` after it is released. */
export async function inspectForkTracking(
  git: GitExec,
  cwd: string,
  identity: RepoIdentity | undefined,
  hosts: ForgeHostMap = {}
): Promise<Result<ForkTrackingInspection | null>> {
  // --short expands an ambiguous branch/tag name to heads/<name>. Read the
  // full ref so tracking always uses the literal branch name.
  const current = await git(["symbolic-ref", "--quiet", "HEAD"], cwd);
  if (!current.ok) return current;
  const branchRef = current.value.stdout.trim();
  if (current.value.exitCode !== 0 || !branchRef.startsWith("refs/heads/")) return ok(null);
  const upstream = await git(["rev-parse", "--symbolic-full-name", "@{u}"], cwd);
  if (!upstream.ok) return upstream;
  if (upstream.value.exitCode !== 0) return ok(null);
  const ref = upstream.value.stdout.trim();
  if (!ref.startsWith("refs/remotes/")) return ok(null);
  const remotes = await listRemoteEndpoints(git, cwd);
  if (!remotes.ok) return remotes;
  const repair = forkTrackingRepair(identity, remotes.value, {
    name: branchRef.slice("refs/heads/".length), upstream: ref.slice("refs/remotes/".length)
  }, hosts);
  // forkTrackingRepair returns null without a parent, so both are known here.
  if (repair === null || identity?.parent === undefined) return ok(null);
  return ok({
    offer: {
      ...repair,
      parent: identity.parent.nameWithOwner,
      targets: [{ remote: "origin", nameWithOwner: identity.nameWithOwner, ref: repair.target }]
    },
    candidates: forkTrackingCandidates(identity, remotes.value, repair, hosts)
  });
}

/** Change tracking, never branch tips or worktree contents. Called under the
 *  repository operation lock; re-read everything the offer was based on. */
export async function repairForkTracking(
  git: GitExec,
  cwd: string,
  identity: RepoIdentity | undefined,
  reviewed: {
    branch: string;
    upstream: string;
    target?: { remote: string; nameWithOwner: string };
  },
  hosts: ForgeHostMap = {}
): Promise<Result<null>> {
  const stale = () => err({
    kind: "remote" as const,
    code: "fork_tracking_stale",
    message: "The branch or fork remotes changed. Reopen Remotes and review tracking again. Nothing was changed."
  });
  const current = await git(["symbolic-ref", "--quiet", "HEAD"], cwd);
  if (!current.ok) return current;
  if (current.value.exitCode !== 0 || current.value.stdout.trim() !== `refs/heads/${reviewed.branch}`) {
    return stale();
  }
  const upstream = await git(["rev-parse", "--symbolic-full-name", "@{u}"], cwd);
  if (!upstream.ok) return upstream;
  if (
    upstream.value.exitCode !== 0 ||
    upstream.value.stdout.trim() !== `refs/remotes/${reviewed.upstream}`
  ) return stale();
  const remotes = await listRemoteEndpoints(git, cwd);
  if (!remotes.ok) return remotes;
  const repair = forkTrackingRepair(
    identity,
    remotes.value,
    { name: reviewed.branch, upstream: reviewed.upstream },
    hosts
  );
  if (repair === null || identity === undefined) return stale();
  // `origin` unless the dialog chose another fork. Whichever it is must still
  // be the repository it was reviewed as: the forge confirmed that one, not
  // whatever the nickname points at now.
  const chosen = reviewed.target ?? { remote: "origin", nameWithOwner: identity.nameWithOwner };
  const sameRepo = (url: string): boolean => {
    const parsed = parseForgeRemote(url, hosts);
    return (
      parsed !== null && parsed.hostname === identity.hostname &&
      parsed.nameWithOwner.toLowerCase() === chosen.nameWithOwner.toLowerCase()
    );
  };
  if (
    chosen.remote === repair.upstreamRemote ||
    chosen.nameWithOwner.toLowerCase() === identity.parent?.nameWithOwner.toLowerCase()
  ) return stale();
  if (
    chosen.remote === "origin" &&
    chosen.nameWithOwner.toLowerCase() !== identity.nameWithOwner.toLowerCase()
  ) return stale();
  const chosenRemote = remotes.value.find((remote) => remote.name === chosen.remote);
  if (chosenRemote === undefined || !sameRepo(chosenRemote.fetchUrl)) return stale();
  // Git pushes to every configured pushurl, while the remote summary carries
  // only the first. Check the whole destination set before offering success.
  const urls = await git(["remote", "get-url", "--push", "--all", "--", chosen.remote], cwd);
  if (!urls.ok) return urls;
  const checkedUrls = requireExit0(urls.value, ["remote", "get-url"]);
  if (!checkedUrls.ok) return checkedUrls;
  if (!checkedUrls.value.stdout.trim().split("\n").every(sameRepo)) return stale();
  const targetRef = `${chosen.remote}/${reviewed.branch}`;
  // A separate push destination must not silently survive a repair that the
  // user expects to send future work to their fork.
  for (const key of [`branch.${reviewed.branch}.pushRemote`, "remote.pushDefault"]) {
    const push = await git(["config", "--get", key], cwd);
    if (!push.ok) return push;
    if (push.value.exitCode !== 0 && push.value.exitCode !== 1) {
      const checked = requireExit0(push.value, ["config", "--get", key]);
      if (!checked.ok) return checked;
    }
    if (push.value.exitCode === 0 && push.value.stdout.trim() !== chosen.remote) {
      return err({
        kind: "remote",
        code: "fork_tracking_push_override",
        message: `${key} sends pushes to ${push.value.stdout.trim()}. Set it to ${chosen.remote} or remove that override before repairing fork tracking. Nothing was changed.`
      });
    }
    if (push.value.exitCode === 0) break;
  }
  const target = await git(["show-ref", "--verify", "--quiet", `refs/remotes/${targetRef}`], cwd);
  if (!target.ok) return target;
  if (target.value.exitCode !== 0) return err({
    kind: "remote",
    code: "fork_tracking_target_missing",
    message: `${targetRef} is not available locally. Fetch ${chosen.remote} first. If that fork does not have this branch, publish it there before retrying. Nothing was changed.`
  });
  const args = ["branch", `--set-upstream-to=refs/remotes/${targetRef}`, "--", reviewed.branch];
  const changed = await git(args, cwd);
  if (!changed.ok) return changed;
  const checked = requireExit0(changed.value, args);
  return checked.ok ? ok(null) : checked;
}
