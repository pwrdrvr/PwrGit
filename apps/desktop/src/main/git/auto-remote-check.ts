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

type Target = { remote: string; remoteRef: string; localRef: string };

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
  const upstreamRef = upstream.value.exitCode === 0
    ? upstream.value.stdout.trim() : null;
  const tracked = upstreamRef === null ? undefined : [...endpoints.value]
    .sort((a, b) => b.name.length - a.name.length)
    .find((endpoint) => upstreamRef.startsWith(`refs/remotes/${endpoint.name}/`));
  if (upstreamRef !== null && tracked === undefined) {
    return err({ kind: "remote", code: "remote_missing", message: "The tracked remote is not configured." });
  }
  const trackedBranch = tracked === undefined || upstreamRef === null
    ? branch : upstreamRef.slice(`refs/remotes/${tracked.name}/`.length);
  const targets: Target[] = [];
  if (tracked !== undefined && upstreamRef !== null) {
    // A custom fetch refspec can map refs/heads/main to origin/other-name.
    // The configured merge ref is the server branch; @{u} is its local home.
    const merge = await git(["config", "--get", `branch.${branch}.merge`], cwd);
    if (!merge.ok) return merge;
    const remoteRef = merge.value.exitCode === 0 ? merge.value.stdout.trim() : "";
    if (!remoteRef.startsWith("refs/heads/") || remoteRef === "refs/heads/") {
      return err({ kind: "remote", code: "remote_config_failed", message: "The tracked branch has no remote head." });
    }
    targets.push({ remote: tracked.name, remoteRef, localRef: upstreamRef });
  }
  const source = forkSourceRemote(endpoints.value, tracked?.name ?? null, parent);
  if (source !== null) {
    const prefix = `refs/remotes/${source.remote}/`;
    const sourceRef = `${prefix}${trackedBranch}`;
    targets.push({ remote: source.remote, remoteRef: `refs/heads/${trackedBranch}`, localRef: sourceRef });
    // Match resolveForkStatus: a branch tracking its home remote's default
    // may use the source's default under a different name when its own name
    // is absent there. Checking both also keeps the default drift fresh.
    if (tracked !== undefined && upstreamRef !== null) {
      const homeHead = await git(
        ["symbolic-ref", "--quiet", `refs/remotes/${tracked.name}/HEAD`], cwd
      );
      if (!homeHead.ok) return homeHead;
      if (homeHead.value.exitCode === 0 && homeHead.value.stdout.trim() === upstreamRef) {
        const sourceHead = await git(
          ["symbolic-ref", "--quiet", `${prefix}HEAD`], cwd
        );
        if (!sourceHead.ok) return sourceHead;
        const defaultRef = sourceHead.value.exitCode === 0
          ? sourceHead.value.stdout.trim() : "";
        if (defaultRef.startsWith(prefix) && defaultRef !== sourceRef) {
          targets.push({
            remote: source.remote,
            remoteRef: `refs/heads/${defaultRef.slice(prefix.length)}`,
            localRef: defaultRef
          });
        }
      }
    }
  }

  for (const target of targets) {
    // Git accepts option-shaped remote names. Do not let one turn a background
    // check into a different command, even when it came from local config.
    if (target.remote.startsWith("-")) {
      return err({ kind: "remote", code: "remote_config_failed", message: "The remote name cannot be checked safely." });
    }
    const advertised = await git(
      ["ls-remote", "--heads", target.remote, target.remoteRef],
      cwd
    );
    if (!advertised.ok) return advertised;
    if (advertised.value.exitCode !== 0) {
      return err({ kind: "remote", code: "fetch_failed", message: "Remote tip check failed." });
    }
    const line = advertised.value.stdout.split("\n").find((row) => row.endsWith(`\t${target.remoteRef}`));
    const remoteHead = line?.split("\t")[0] ?? "";
    const local = await git(["rev-parse", "--verify", "--quiet", target.localRef], cwd);
    if (!local.ok) return local;
    // A deleted branch must stop contributing stale counts. Compare the old
    // OID when deleting so another Git client cannot lose a newer update.
    if (advertised.value.stdout.trim() === "") {
      if (local.value.exitCode === 0) {
        const removed = await git(
          ["update-ref", "-d", target.localRef, local.value.stdout.trim()], cwd
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
      `+${target.remoteRef}:${target.localRef}`,
      true
    );
    if (!fetched.ok) return fetched;
    onFetched();
  }
  return ok(targets.length === 0 ? "untracked" : "checked");
}
