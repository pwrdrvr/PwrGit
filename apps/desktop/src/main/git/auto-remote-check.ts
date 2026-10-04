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

type Target = { remote: string; remoteRef: string; localRef: string; optional?: boolean };

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
type TipAnswer = Result<"checked" | "untracked" | "unavailable">;

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
  const symbolicHeads = new Map<string, Promise<Awaited<ReturnType<GitExec>>>>();
  const byRemote = new Map<string, {
    remote: string; cwd: string;
    targets: Map<string, { target: Target; cwd: string; owners: Map<string, boolean> }>
  }>();
  for (const worktree of worktrees) {
    // Tracking, conditional includes, and remote URLs are effective checkout
    // configuration, even though these worktrees share the same ref storage.
    const config = await readTrackingConfiguration(git, worktree.path, worktree.branch);
    if (!config.ok) { answers.set(worktree.id, config); continue; }
    const { endpoints, upstreamRef, mergeRef } = config.value;
    const symbolicHead = (ref: string): ReturnType<GitExec> => {
      const key = `${worktree.path}\0${ref}`;
      let result = symbolicHeads.get(key);
      if (result === undefined) {
        result = git(["symbolic-ref", "--quiet", ref], worktree.path);
        symbolicHeads.set(key, result);
      }
      return result;
    };
    const planned = await remoteTargets(worktree.branch, parent, endpoints, upstreamRef, mergeRef, symbolicHead,
      (remote) => git(["config", "--get-all", `remote.${remote}.fetch`], worktree.path));
    if (!planned.ok) { answers.set(worktree.id, planned); continue; }
    answers.set(worktree.id, ok(planned.value.length === 0 ? "untracked" : "unavailable"));
    for (const target of planned.value) {
      const endpoint = endpoints.find((endpoint) => endpoint.name === target.remote)!;
      // A worktree override can give the same remote name a different URL.
      // Only advertisements for the same effective endpoint may be shared.
      const key = `${target.remote}\0${endpoint.fetchUrl}`;
      const group = byRemote.get(key) ?? { remote: target.remote, cwd: worktree.path, targets: new Map() };
      byRemote.set(key, group);
      const refKey = `${target.remoteRef}\0${target.localRef}`;
      const entry = group.targets.get(refKey) ?? { target, cwd: worktree.path, owners: new Map<string, boolean>() };
      entry.owners.set(worktree.id, target.optional === true);
      group.targets.set(refKey, entry);
    }
  }
  const groups = [...byRemote.values()];
  const required = (group: typeof groups[number]): boolean => [...group.targets.values()]
    .some(({ owners }) => [...owners.values()].some((optional) => !optional));
  // Source/tracked checks run before optional publication counterparts, which
  // can exhaust the shared timeout. Optional failures stay local to that ref.
  groups.sort((a, b) => Number(required(b)) - Number(required(a)));
  const failOwners = (owners: Map<string, boolean>, answer: TipAnswer): void => {
    for (const [id, optional] of owners) if (!optional) answers.set(id, answer);
  };
  for (const { remote, cwd, targets } of groups) {
    const fail = (answer: TipAnswer): void => {
      for (const { owners } of targets.values()) failOwners(owners, answer);
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
    for (const { target, cwd: targetCwd, owners } of targets.values()) {
      const remoteHead = heads.get(target.remoteRef) ?? "";
      const deleted = !heads.has(target.remoteRef);
      const local = await git(["rev-parse", "--verify", "--quiet", target.localRef], targetCwd);
      if (!local.ok) { failOwners(owners, local); continue; }
      const current = local.value.exitCode === 0 ? local.value.stdout.trim() : null;
      if (!(deleted ? current === null : current === remoteHead)) {
        const updated = await exclusive(() => syncTrackingRef(git, targetCwd, target, remoteHead, deleted));
        if (!updated.ok) { failOwners(owners, updated); continue; }
        if (updated.value) onFetched();
      }
      for (const id of owners.keys()) if (answers.get(id)?.ok) answers.set(id, ok("checked"));
    }
  }
  return answers;
}

/** Git applies config.worktree and conditional includes in this context. */
async function readTrackingConfiguration(git: GitExec, cwd: string, branch: string): Promise<Result<{
  endpoints: RemoteEndpoint[];
  upstreamRef: string | null;
  mergeRef: string;
}>> {
  const endpoints = await listRemoteEndpoints(git, cwd);
  if (!endpoints.ok) return endpoints;
  const head = `refs/heads/${branch}`;
  const tracking = await git([
    "for-each-ref", "--format=%(refname)%00%(upstream)", head
  ], cwd);
  if (!tracking.ok) return tracking;
  if (tracking.value.exitCode !== 0) return err({
    kind: "remote", code: "remote_config_failed", message: "Could not read branch tracking."
  });
  // for-each-ref also includes descendants of this name; select the exact ref.
  const upstreamRef = tracking.value.stdout.split("\n")
    .find((line) => line.startsWith(`${head}\0`))?.slice(head.length + 1).trim() || null;
  const config = await git(["config", "--get", `branch.${branch}.merge`], cwd);
  if (!config.ok) return config;
  if (config.value.exitCode !== 0 && config.value.exitCode !== 1) return err({
    kind: "remote", code: "remote_config_failed", message: "Could not read branch merge refs."
  });
  return ok({ endpoints: endpoints.value, upstreamRef, mergeRef: config.value.stdout.trim() });
}

async function remoteTargets(
  branch: string, parent: ForkParentHint | null, endpoints: RemoteEndpoint[],
  upstreamRef: string | null, remoteRef: string,
  symbolicHead: (ref: string) => ReturnType<GitExec>,
  fetchMappings: (remote: string) => ReturnType<GitExec>
): Promise<Result<Target[]>> {
  const tracked = upstreamRef === null ? undefined : [...endpoints]
    .sort((a, b) => b.name.length - a.name.length)
    .find((endpoint) => upstreamRef.startsWith(`refs/remotes/${endpoint.name}/`));
  if (upstreamRef !== null && tracked === undefined) {
    return err({ kind: "remote", code: "remote_missing", message: "The tracked remote is not configured." });
  }
  const trackedBranch = tracked === undefined || upstreamRef === null
    ? branch : upstreamRef.slice(`refs/remotes/${tracked.name}/`.length);
  const source = forkSourceRemote(endpoints, tracked?.name ?? null, parent);
  const counterparts = upstreamRef === null && !branch.startsWith("detached@");
  const targets: Target[] = [];
  if (tracked !== undefined && upstreamRef !== null) {
    // A custom fetch refspec can map refs/heads/main to origin/other-name.
    // The configured merge ref is the server branch; @{u} is its local home.
    if (!remoteRef.startsWith("refs/heads/") || remoteRef === "refs/heads/") {
      return err({ kind: "remote", code: "remote_config_failed", message: "The tracked branch has no remote head." });
    }
    targets.push({ remote: tracked.name, remoteRef, localRef: upstreamRef });
  } else if (counterparts) {
    // A branch may be published without -u. Refresh its mapped counterparts
    // so another client's push stops contributing stale local-only counts.
    for (const endpoint of endpoints) {
      const optional = endpoint.name !== source?.remote;
      const mappings = await fetchMappings(endpoint.name);
      if (!mappings.ok) { if (!optional) return mappings; continue; }
      if (mappings.value.exitCode !== 0 && mappings.value.exitCode !== 1) {
        if (!optional) return err({ kind: "remote", code: "remote_config_failed", message: "Could not read fetch mappings." });
        continue;
      }
      const remoteRef = `refs/heads/${branch}`;
      for (const localRef of mappedTrackingRefs(remoteRef, mappings.value.stdout.trim().split("\n"))) {
        targets.push({ remote: endpoint.name, remoteRef, localRef, optional });
      }
    }
  }
  if (!counterparts && source !== null && !targets.some((target) => target.remote === source.remote)) {
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

/** Match Git's exact/pattern fetch mappings, including negative exclusions.
 * Only remote-tracking refs may be written by an automatic counterpart check. */
function mappedTrackingRefs(remoteRef: string, refspecs: string[]): string[] {
  const match = (pattern: string): string | null => {
    const star = pattern.indexOf("*");
    if (star === -1) return pattern === remoteRef ? "" : null;
    if (pattern.indexOf("*", star + 1) !== -1) return null;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    return remoteRef.startsWith(prefix) && remoteRef.endsWith(suffix) && remoteRef.length >= prefix.length + suffix.length
      ? remoteRef.slice(prefix.length, remoteRef.length - suffix.length) : null;
  };
  if (refspecs.some((refspec) => refspec.startsWith("^") && match(refspec.slice(1)) !== null)) return [];
  const destinations = new Set<string>();
  for (const refspec of refspecs) {
    const positive = refspec.startsWith("+") ? refspec.slice(1) : refspec;
    const colon = positive.indexOf(":");
    if (colon === -1 || positive.startsWith("^")) continue;
    const from = positive.slice(0, colon);
    const to = positive.slice(colon + 1);
    const captured = match(from);
    if (captured === null || from.includes("*") !== to.includes("*")) continue;
    const destination = to.replace("*", captured);
    if (destination.startsWith("refs/remotes/") && destination !== "refs/remotes/" && !destination.includes("*")) {
      destinations.add(destination);
    }
  }
  return [...destinations];
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
