import { err, ok, type ForgeHostMap, type RemoteEndpoint, type Result } from "@pwrgit/shared";
import { sanitizeGitLogDetail, type GitExec } from "./dugite";
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

type CheckedWorktree = { id: string; path: string; branch: string };
type TipAnswer = Result<"checked" | "untracked">;

/** Resolve every requested checkout before networking. One advertisement per
 * remote answers all its requested heads; absence is tested per exact ref. */
export async function checkRemoteTips(
  git: GitExec,
  worktrees: CheckedWorktree[],
  parent: ForkParentHint | null,
  exclusive: <T>(run: () => Promise<T>) => Promise<T>,
  onFetched: () => void
): Promise<Map<string, TipAnswer>> {
  const answers = new Map<string, TipAnswer>();
  const cwd = worktrees[0]?.path;
  if (cwd === undefined) return answers;
  const endpoints = await listRemoteEndpoints(git, cwd);
  if (!endpoints.ok) return new Map(worktrees.map((w) => [w.id, endpoints]));
  const tracking = await git([
    "for-each-ref", "--format=%(refname)%00%(upstream)", "refs/heads"
  ], cwd);
  if (!tracking.ok) return new Map(worktrees.map((w) => [w.id, tracking]));
  if (tracking.value.exitCode !== 0) return new Map(worktrees.map((w) => [w.id, err({
    kind: "remote", code: "remote_config_failed", message: "Could not read branch tracking."
  })]));
  const upstreams = new Map(tracking.value.stdout.trim().split("\n").map((line) => {
    const [ref, upstream] = line.split("\0");
    return [ref?.slice("refs/heads/".length), upstream || null] as const;
  }));
  const config = await git(["config", "--get-regexp", "^branch\\..*\\.merge$"], cwd);
  if (!config.ok) return new Map(worktrees.map((w) => [w.id, config]));
  if (config.value.exitCode !== 0 && config.value.exitCode !== 1) return new Map(worktrees.map((w) => [w.id, err({
    kind: "remote", code: "remote_config_failed", message: "Could not read branch merge refs."
  })]));
  const merges = new Map(config.value.stdout.trim().split("\n").map((line) => {
    const split = line.indexOf(" ");
    return [line.slice(0, split), line.slice(split + 1)] as const;
  }));
  const symbolicHeads = new Map<string, Promise<Awaited<ReturnType<GitExec>>>>();
  const symbolicHead = (ref: string): ReturnType<GitExec> => {
    let result = symbolicHeads.get(ref);
    if (result === undefined) {
      result = git(["symbolic-ref", "--quiet", ref], cwd);
      symbolicHeads.set(ref, result);
    }
    return result;
  };
  const byRemote = new Map<string, Map<string, { target: Target; owners: Set<string> }>>();
  for (const worktree of worktrees) {
    const planned = await remoteTargets(worktree.branch, parent, endpoints.value,
      upstreams.get(worktree.branch) ?? null, merges.get(`branch.${worktree.branch}.merge`) ?? "", symbolicHead);
    if (!planned.ok) { answers.set(worktree.id, planned); continue; }
    answers.set(worktree.id, ok(planned.value.length === 0 ? "untracked" : "checked"));
    for (const target of planned.value) {
      const targets = byRemote.get(target.remote) ?? new Map();
      byRemote.set(target.remote, targets);
      const key = `${target.remoteRef}\0${target.localRef}`;
      const entry = targets.get(key) ?? { target, owners: new Set<string>() };
      entry.owners.add(worktree.id);
      targets.set(key, entry);
    }
  }
  for (const [remote, targets] of byRemote) {
    const fail = (answer: TipAnswer): void => {
      for (const { owners } of targets.values()) for (const id of owners) answers.set(id, answer);
    };
    if (remote.startsWith("-")) {
      fail(err({ kind: "remote", code: "remote_config_failed", message: "The remote name cannot be checked safely." }));
      continue;
    }
    const refs = [...new Set([...targets.values()].map(({ target }) => target.remoteRef))];
    // Keep one advertisement even for a batch whose names would exceed
    // Windows' command-line limit: ask for all heads, then select exact refs.
    const patterns = refs.reduce((length, ref) => length + ref.length + 1, 0) < 8_000 ? refs : [];
    const advertised = await git(["ls-remote", "--heads", remote, ...patterns], cwd);
    if (!advertised.ok) { fail(advertised); continue; }
    if (advertised.value.exitCode !== 0) {
      fail(err({ kind: "remote", code: "fetch_failed", message: sanitizeGitLogDetail(advertised.value.stderr) || "Remote tip check failed." }));
      continue;
    }
    const heads = new Map(advertised.value.stdout.trim().split("\n").map((line) => {
      const [oid, ref] = line.split("\t");
      return [ref, oid] as const;
    }));
    for (const { target, owners } of targets.values()) {
      const remoteHead = heads.get(target.remoteRef) ?? "";
      const deleted = !heads.has(target.remoteRef);
      const local = await git(["rev-parse", "--verify", "--quiet", target.localRef], cwd);
      if (!local.ok) { for (const id of owners) answers.set(id, local); continue; }
      const current = local.value.exitCode === 0 ? local.value.stdout.trim() : null;
      if (deleted ? current === null : current === remoteHead) continue;
      const updated = await exclusive(() => syncTrackingRef(git, cwd, target, remoteHead, deleted));
      if (!updated.ok) { for (const id of owners) answers.set(id, updated); continue; }
      if (updated.value) onFetched();
    }
  }
  return answers;
}

async function remoteTargets(
  branch: string, parent: ForkParentHint | null, endpoints: RemoteEndpoint[],
  upstreamRef: string | null, remoteRef: string,
  symbolicHead: (ref: string) => ReturnType<GitExec>
): Promise<Result<Target[]>> {
  const tracked = upstreamRef === null ? undefined : [...endpoints]
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
    if (!remoteRef.startsWith("refs/heads/") || remoteRef === "refs/heads/") {
      return err({ kind: "remote", code: "remote_config_failed", message: "The tracked branch has no remote head." });
    }
    targets.push({ remote: tracked.name, remoteRef, localRef: upstreamRef });
  }
  const source = forkSourceRemote(endpoints, tracked?.name ?? null, parent);
  if (source !== null) {
    const prefix = `refs/remotes/${source.remote}/`;
    const sourceRef = `${prefix}${trackedBranch}`;
    targets.push({ remote: source.remote, remoteRef: `refs/heads/${trackedBranch}`, localRef: sourceRef });
    // Match resolveForkStatus: a branch tracking its home remote's default
    // may use the source's default under a different name when its own name
    // is absent there. Checking both also keeps the default drift fresh.
    if (tracked !== undefined && upstreamRef !== null) {
      const homeHead = await symbolicHead(`refs/remotes/${tracked.name}/HEAD`);
      if (!homeHead.ok) return homeHead;
      if (homeHead.value.exitCode === 0 && homeHead.value.stdout.trim() === upstreamRef) {
        const sourceHead = await symbolicHead(`${prefix}HEAD`);
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

  return ok(targets);
}

/** Bring one tracking ref to the advertised tip; true when it moved. */
async function syncTrackingRef(
  git: GitExec,
  cwd: string,
  target: Target,
  remoteHead: string,
  deleted: boolean
): Promise<Result<boolean>> {
  const local = await git(["rev-parse", "--verify", "--quiet", target.localRef], cwd);
  if (!local.ok) return local;
  // A deleted branch must stop contributing stale counts. Compare the old
  // OID when deleting so another Git client cannot lose a newer update.
  if (deleted) {
    if (local.value.exitCode !== 0) return ok(false);
    const removed = await git(
      ["update-ref", "-d", target.localRef, local.value.stdout.trim()], cwd
    );
    if (!removed.ok) return removed;
    if (removed.value.exitCode !== 0) {
      return err({ kind: "remote", code: "fetch_failed", message: "Remote ref changed during the check." });
    }
    return ok(true);
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(remoteHead)) {
    return err({ kind: "remote", code: "remote_missing", message: "Remote branch was not advertised." });
  }
  if (local.value.exitCode === 0 && local.value.stdout.trim() === remoteHead) return ok(false);
  const fetched = await fetchRefspec(
    git,
    cwd,
    target.remote,
    `+${target.remoteRef}:${target.localRef}`
  );
  return fetched.ok ? ok(true) : fetched;
}
