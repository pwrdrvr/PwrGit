import {
  err,
  forkTrackingRepair,
  ok,
  parseForgeRemote,
  type ForgeHostMap,
  type ForkTrackingRepair,
  type RepoIdentity,
  type Result
} from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";
import { listRemoteEndpoints } from "./git-service";

/** Read the actual checked-out branch; a repo row may have changed since the
 *  denied push. No forge or remote network calls are made here. */
export async function inspectForkTracking(
  git: GitExec,
  cwd: string,
  identity: RepoIdentity | undefined,
  hosts: ForgeHostMap = {}
): Promise<Result<ForkTrackingRepair | null>> {
  const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  if (!current.ok) return current;
  if (current.value.exitCode !== 0) return ok(null);
  const upstream = await git(["rev-parse", "--symbolic-full-name", "@{u}"], cwd);
  if (!upstream.ok) return upstream;
  if (upstream.value.exitCode !== 0) return ok(null);
  const ref = upstream.value.stdout.trim();
  if (!ref.startsWith("refs/remotes/")) return ok(null);
  const remotes = await listRemoteEndpoints(git, cwd);
  if (!remotes.ok) return remotes;
  return ok(forkTrackingRepair(identity, remotes.value, {
    name: current.value.stdout.trim(), upstream: ref.slice("refs/remotes/".length)
  }, hosts));
}

/** Change tracking, never branch tips or worktree contents. Called under the
 *  repository operation lock; re-read everything the offer was based on. */
export async function repairForkTracking(
  git: GitExec,
  cwd: string,
  identity: RepoIdentity | undefined,
  reviewed: { branch: string; upstream: string },
  hosts: ForgeHostMap = {}
): Promise<Result<null>> {
  const stale = () => err({
    kind: "remote" as const,
    code: "fork_tracking_stale",
    message: "The branch or fork remotes changed. Reopen Remotes and review tracking again. Nothing was changed."
  });
  const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  if (!current.ok) return current;
  if (current.value.exitCode !== 0 || current.value.stdout.trim() !== reviewed.branch) {
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
  if (repair === null) return stale();
  // Git pushes to every configured pushurl, while the remote summary carries
  // only the first. Check the whole destination set before offering success.
  const urls = await git(["remote", "get-url", "--push", "--all", "origin"], cwd);
  if (!urls.ok) return urls;
  const checkedUrls = requireExit0(urls.value, ["remote", "get-url"]);
  if (!checkedUrls.ok) return checkedUrls;
  if (identity === undefined) return stale();
  const wrongDestination = checkedUrls.value.stdout.trim().split("\n").some((url) => {
    const parsed = parseForgeRemote(url, hosts);
    return (
      parsed === null || parsed.hostname !== identity.hostname ||
      parsed.nameWithOwner.toLowerCase() !== identity.nameWithOwner.toLowerCase()
    );
  });
  if (wrongDestination) return stale();
  // A separate push destination must not silently survive a repair that the
  // user expects to send future work to their fork.
  for (const key of [`branch.${reviewed.branch}.pushRemote`, "remote.pushDefault"]) {
    const push = await git(["config", "--get", key], cwd);
    if (!push.ok) return push;
    if (push.value.exitCode !== 0 && push.value.exitCode !== 1) {
      const checked = requireExit0(push.value, ["config", "--get", key]);
      if (!checked.ok) return checked;
    }
    if (push.value.exitCode === 0 && push.value.stdout.trim() !== "origin") {
      return err({
        kind: "remote",
        code: "fork_tracking_push_override",
        message: `${key} sends pushes to ${push.value.stdout.trim()}. Set it to origin or remove that override before repairing fork tracking. Nothing was changed.`
      });
    }
    if (push.value.exitCode === 0) break;
  }
  const target = await git(["show-ref", "--verify", "--quiet", `refs/remotes/${repair.target}`], cwd);
  if (!target.ok) return target;
  if (target.value.exitCode !== 0) return err({
    kind: "remote",
    code: "fork_tracking_target_missing",
    message: `${repair.target} is not available locally. Fetch origin first. If your fork does not have this branch, publish it there before retrying. Nothing was changed.`
  });
  const args = ["branch", `--set-upstream-to=refs/remotes/${repair.target}`, "--", reviewed.branch];
  const changed = await git(args, cwd);
  if (!changed.ok) return changed;
  const checked = requireExit0(changed.value, args);
  return checked.ok ? ok(null) : checked;
}
