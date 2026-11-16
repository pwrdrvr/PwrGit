import { readFile, stat, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BulkSyncRemoteResult, BulkSyncWorktreeResult } from "@pwrgit/shared";
import { NO_OPTIONAL_LOCKS, type GitExec } from "./dugite";
import { parseStatus } from "./worktree-state";

export const BULK_OPERATION_STATE_PATHS = [
  "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"
] as const;

type Ref = { name: string; oid: string; upstream: string; remote: string; track: string; path: string; symbolic: string };
type Remote = { name: string; skipFetchAll: boolean; configError: boolean; standardMapping: boolean; noTags: boolean };
export type BulkSyncSnapshot = {
  path: string;
  refs: Map<string, Ref>;
  checkouts: Map<string, Ref>;
  remotes: Remote[];
  checkoutDependent: boolean;
  configuration: string;
};

type Configuration = Map<string, Array<string | null>>;

function boolean(value: string | null): boolean | null {
  if (value === null || ["true", "yes", "on", "1"].includes(value.toLowerCase())) return true;
  if (["", "false", "no", "off", "0"].includes(value.toLowerCase())) return false;
  return null;
}

async function readConfiguration(git: GitExec, cwd: string): Promise<Configuration | null> {
  const raw = await git(["config", "--null", "--list", "--includes"], cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok || raw.value.exitCode !== 0 || !raw.value.stdout.endsWith("\0")) return null;
  const config: Configuration = new Map();
  for (const record of raw.value.stdout.split("\0").slice(0, -1)) {
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const values = config.get(key) ?? [];
    values.push(newline < 0 ? null : record.slice(newline + 1));
    config.set(key, values);
  }
  return config;
}

/** Identity-only includes need not disable batching. Compare every effective
 * setting that can change branch tracking or which repository Git reads. */
function trackingConfiguration(config: Configuration): string {
  return JSON.stringify([...config].filter(([key]) =>
    /^branch\..+\.(remote|merge)$/.test(key) || key.startsWith("remote.") ||
    key === "core.bare" || key === "core.worktree"
  ).sort(([a], [b]) => a.localeCompare(b)));
}

/** Read effective configuration every cycle. Fetch still uses the primary
 * checkout's configuration, as it does on the ordinary bulk-pull path. */
export async function readBulkSyncSnapshot(git: GitExec, cwd: string): Promise<BulkSyncSnapshot | null> {
  const config = await readConfiguration(git, cwd);
  if (config === null) return null;
  const remotes: Remote[] = [];
  const configuredNames = new Set([...config.keys()].flatMap((key) => /^remote\.(.+)\.[^.]+$/.exec(key)?.[1] ?? []));
  if ([...configuredNames].some((name) => !config.has(`remote.${name}.url`))) return null;
  for (const key of config.keys()) {
    const match = /^remote\.(.+)\.url$/.exec(key);
    if (match === null) continue;
    const name = match[1]!;
    if (name.startsWith("-")) return null;
    const skip = config.get(`remote.${name}.skipfetchall`)?.at(-1);
    const skipFetchAll = skip === undefined ? false : boolean(skip);
    // Git accepts additional numeric boolean spellings. Let Git interpret
    // those, and report malformed values, through the ordinary path.
    if (skipFetchAll === null) return null;
    const mappings = config.get(`remote.${name}.fetch`) ?? [];
    remotes.push({
      name, skipFetchAll, configError: false,
      standardMapping: mappings.length === 1 && mappings[0] === `+refs/heads/*:refs/remotes/${name}/*`,
      noTags: config.get(`remote.${name}.tagopt`)?.at(-1) === "--no-tags" &&
        !config.has("fetch.prunetags") && !config.has(`remote.${name}.prunetags`)
    });
  }
  const refs = await readBulkSyncRefs(git, cwd);
  const worktreeConfig = config.get("extensions.worktreeconfig")?.at(-1);
  return refs === null ? null : {
    ...refs, remotes, path: resolve(cwd),
    checkoutDependent: [...config.keys()].some((key) => key.startsWith("includeif.")) ||
      (worktreeConfig !== undefined && boolean(worktreeConfig) !== false),
    configuration: trackingConfiguration(config)
  };
}

/** One Git invocation for branch tips, tracking, ancestry and checkout owners.
 * trackshort is machine-readable; the long tracking sentence is translated. */
export async function readBulkSyncRefs(git: GitExec, cwd: string): Promise<Pick<BulkSyncSnapshot, "refs" | "checkouts"> | null> {
  const raw = await git([
    "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:trackshort)%00%(worktreepath)%00%(symref)",
    "refs/heads", "refs/remotes", "refs/tags"
  ], cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok || raw.value.exitCode !== 0) return null;
  const refs = new Map<string, Ref>();
  const checkouts = new Map<string, Ref>();
  for (const line of raw.value.stdout.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\0");
    if (parts.length !== 7) return null;
    const [name, oid, upstream, remote, track, path, symbolic] = parts as [string, string, string, string, string, string, string];
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) return null;
    const ref = { name, oid, upstream, remote, track, path, symbolic };
    refs.set(name, ref);
    if (path !== "") checkouts.set(resolve(path), ref);
  }
  return { refs, checkouts };
}

/** Include tag names/ids and symbolic refs: a newly followed tag or a changed
 * default-branch alias must still invalidate the repository's displayed state. */
export function bulkSyncRefsChanged(before: BulkSyncSnapshot["refs"], after: BulkSyncSnapshot["refs"]): boolean {
  return before.size !== after.size || [...before].some(([name, ref]) => {
    const next = after.get(name);
    return next === undefined || ref.oid !== next.oid || ref.symbolic !== next.symbolic;
  });
}

/** Only the ordinary wildcard mapping can use this shortcut. Unusual refspecs
 * retain Git fetch's own mapping, pruning and validation semantics. */
export function remoteTipsUnchanged(snapshot: BulkSyncSnapshot, remote: string, advertisement: string): boolean {
  if (!snapshot.remotes.find((entry) => entry.name === remote)?.standardMapping) return false;
  const prefix = `refs/remotes/${remote}/`;
  const local = new Map([...snapshot.refs.values()]
    .filter((ref) => ref.name.startsWith(prefix) && ref.symbolic === "")
    .map((ref) => [`refs/heads/${ref.name.slice(prefix.length)}`, ref.oid]));
  const heads = new Map<string, string>();
  for (const line of advertisement.split("\n")) {
    if (line === "") continue;
    const [oid, name, extra] = line.split("\t");
    if (extra !== undefined || name === undefined || !name.startsWith("refs/heads/") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid ?? "")) return false;
    heads.set(name, oid!);
  }
  return local.size === heads.size && [...heads].every(([name, oid]) => local.get(name) === oid);
}

/** A shortcut only reports a read; it never authorizes a mutation. Pending,
 * diverged and uncertain checkouts always retain both pull-safety inspections. */
export async function unchangedWorktree(
  git: GitExec,
  snapshot: BulkSyncSnapshot,
  path: string,
  remotes: ReadonlyMap<string, BulkSyncRemoteResult>
): Promise<Pick<BulkSyncWorktreeResult, "branch" | "outcome" | "reason" | "message" | "beforeHead" | "afterHead"> | null> {
  const ref = snapshot.checkouts.get(resolve(path));
  if (ref === undefined) return null;
  const remote = remotes.get(ref.remote);
  if (ref.upstream !== "" && remote?.outcome !== "fetched" && remote?.reason !== "unchanged") return null;
  const upstream = snapshot.refs.get(ref.upstream);
  const current = upstream?.oid === ref.oid;
  const ahead = ref.track === ">";
  if (ref.upstream !== "" && !current && !ahead) return null;
  if (snapshot.checkoutDependent && resolve(path) !== snapshot.path) {
    const config = await readConfiguration(git, path);
    if (config === null || trackingConfiguration(config) !== snapshot.configuration) return null;
  }
  try {
    const dotGit = join(path, ".git");
    const info = await stat(dotGit);
    const pointer = info.isDirectory() ? null : /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
    if (!info.isDirectory() && pointer === null) return null;
    const admin = info.isDirectory() ? dotGit : resolve(path, pointer![1]!);
    // A branch switch after the batch snapshot must not use its predecessor's
    // answer. Active operations keep their existing detailed refusal reasons.
    if ((await readFile(join(admin, "HEAD"), "utf8")).trim() !== `ref: ${ref.name}`) return null;
    const operating = await Promise.all(BULK_OPERATION_STATE_PATHS.map((name) =>
      access(join(admin, name)).then(() => true, () => false)));
    if (operating.some(Boolean)) return null;
  } catch { return null; }
  const branch = ref.name.slice("refs/heads/".length);
  // This runs under the checkout lock, after networking and queue waits.
  // Git resolves the live HEAD/upstream relationship and reads unmerged index
  // stages, including stash-pop conflicts that have no operation marker.
  // Omitting untracked enumeration avoids the expensive full safety scan;
  // any uncertain or changed answer goes through that scan before mutation.
  const raw = await git(["status", "--porcelain=v2", "--branch", "--untracked-files=no"], path, NO_OPTIONAL_LOCKS);
  if (!raw.ok || raw.value.exitCode !== 0) return null;
  const lines = raw.value.stdout.split("\n");
  if (lines.some((line) => line.startsWith("u "))) return {
    branch, outcome: "skipped", reason: "conflicts", message: "The worktree has unresolved conflicts."
  };
  const live = parseStatus(raw.value.stdout);
  const upstreamName = lines.find((line) => line.startsWith("# branch.upstream "))?.slice(18).trim() ?? "";
  const expectedUpstream = ref.upstream.replace(/^refs\/(?:remotes|heads)\//, "");
  if (live.branch !== branch || live.head !== ref.oid || live.upstreamGone || upstreamName !== expectedUpstream) return null;
  if (current && (live.ahead !== 0 || live.behind !== 0)) return null;
  if (ahead && (live.ahead <= 0 || live.behind !== 0)) return null;
  if (current) return { branch, outcome: "up_to_date", beforeHead: ref.oid, afterHead: ref.oid };
  return { branch, outcome: "skipped", reason: ahead ? "ahead" : "no_upstream" };
}
