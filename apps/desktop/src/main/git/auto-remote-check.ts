import { err, ok, type ForgeHostMap, type Result } from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import {
  addForkParentRemote,
  planUpstreamRemote,
  readCheckoutRemotes
} from "./fork-remotes";
import {
  fetchRefspec,
  forkSourceRemote,
  listRemoteEndpoints,
  type ForkParentHint
} from "./git-service";

type Target = { remote: string; branch: string };

/** Make a known fork parent visible to the ordinary fork sync path. */
export async function ensureForkParentRemote(
  git: GitExec,
  cwd: string,
  parent: ForkParentHint,
  fork: { hostname: string; nameWithOwner: string },
  hosts: ForgeHostMap = {}
): Promise<Result<void>> {
  const remotes = await readCheckoutRemotes(git, cwd);
  if (!remotes.ok) return remotes;
  const plan = planUpstreamRemote(remotes.value, parent, hosts);
  if (plan.existing) return ok(undefined);
  const added = await addForkParentRemote(
    git, cwd, parent, { name: plan.name }, fork, hosts
  );
  return added.ok ? ok(undefined) : err(added.error);
}

/** Read only the refs that can change the selected branch's sync chip. */
export async function checkSelectedRemoteTips(
  git: GitExec,
  cwd: string,
  branch: string,
  parent: ForkParentHint | null,
  onFetching: () => void,
  onFetched: () => void
): Promise<Result<"checked" | "untracked">> {
  const endpoints = await listRemoteEndpoints(git, cwd);
  if (!endpoints.ok) return endpoints;
  const upstream = await git(["rev-parse", "--symbolic-full-name", "@{u}"], cwd);
  if (!upstream.ok) return upstream;
  if (upstream.value.exitCode !== 0) return ok("untracked");

  const upstreamRef = upstream.value.stdout.trim();
  const tracked = [...endpoints.value]
    .sort((a, b) => b.name.length - a.name.length)
    .find((endpoint) => upstreamRef.startsWith(`refs/remotes/${endpoint.name}/`));
  if (tracked === undefined) return ok("untracked");
  const trackedBranch = upstreamRef.slice(`refs/remotes/${tracked.name}/`.length);
  if (trackedBranch === "") return ok("untracked");
  const targets: Target[] = [{ remote: tracked.name, branch: trackedBranch }];
  const source = forkSourceRemote(endpoints.value, tracked.name, parent);
  if (source !== null) targets.push({ remote: source.remote, branch });

  for (const target of targets) {
    // Git accepts option-shaped remote names. Do not let one turn a background
    // check into a different command, even when it came from local config.
    if (target.remote.startsWith("-")) return ok("untracked");
    const remoteRef = `refs/heads/${target.branch}`;
    const localRef = `refs/remotes/${target.remote}/${target.branch}`;
    const advertised = await git(
      ["ls-remote", "--heads", target.remote, remoteRef],
      cwd
    );
    if (!advertised.ok) return advertised;
    if (advertised.value.exitCode !== 0) {
      return err({ kind: "remote", code: "fetch_failed", message: "Remote tip check failed." });
    }
    const line = advertised.value.stdout.split("\n").find((row) => row.endsWith(`\t${remoteRef}`));
    const remoteHead = line?.split("\t")[0] ?? "";
    const local = await git(["rev-parse", "--verify", "--quiet", localRef], cwd);
    if (!local.ok) return local;
    // A deleted branch must stop contributing stale counts. Compare the old
    // OID when deleting so another Git client cannot lose a newer update.
    if (advertised.value.stdout.trim() === "") {
      if (local.value.exitCode === 0) {
        const removed = await git(
          ["update-ref", "-d", localRef, local.value.stdout.trim()], cwd
        );
        if (!removed.ok) return removed;
        if (removed.value.exitCode !== 0) {
          return err({ kind: "remote", code: "fetch_failed", message: "Remote ref changed during the check." });
        }
        onFetched();
      }
      continue;
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(remoteHead)) {
      return err({ kind: "remote", code: "remote_missing", message: "Remote branch was not advertised." });
    }
    if (local.value.exitCode === 0 && local.value.stdout.trim() === remoteHead) continue;
    onFetching();
    const fetched = await fetchRefspec(
      git,
      cwd,
      target.remote,
      `+${remoteRef}:${localRef}`,
      true
    );
    if (!fetched.ok) return fetched;
    onFetched();
  }
  return ok("checked");
}
