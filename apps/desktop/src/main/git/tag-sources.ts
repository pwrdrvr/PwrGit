import {
  err,
  ok,
  TAG_PAGE_MAX,
  TAG_PAGE_SIZE,
  TAG_SOURCE_VIEW_TTL_MS,
  type ReplacedTag,
  type RemoteTagValue,
  type Result,
  type TagAdoptResult,
  type TagDetails,
  type TagSourceState,
  type TagStatusCounts,
  type TagStatusFilter,
  type TagStatusPage,
  type TagStatusRow,
  type TagSummary,
  type TagSyncStatus
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { requireExit0, type GitExec } from "./dugite";
import { readAllTagSummaries, readTagSummaries, validTagName } from "./git-service";

/**
 * Published tags: Git keeps ONE `refs/tags/*` for every remote, and a fetch
 * never rewrites a name that exists. PwrGit records what each remote published
 * in its own database (a ref cannot point at objects that are not here), picks
 * one remote as the publisher, compares, and changes `refs/tags/<name>` only
 * when the user adopts that one tag.
 */

export const REPLACED_TAG_PREFIX = "refs/pwrgit/replaced-tags/";
const INCOMING_TAG_PREFIX = "refs/pwrgit/incoming-tags/";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type ListedTag = {
  name: string;
  objectId: string;
  targetId: string;
  annotated: boolean;
};

export type RemoteConfig = {
  name: string;
  url: string | null;
  tagOpt: string | null;
};

// --------------------------------------------------------------------------
// Git reads
// --------------------------------------------------------------------------

/** Every remote's url and tagOpt from one `git config -z --get-regexp`. */
export async function readRemoteConfig(
  git: GitExec,
  cwd: string
): Promise<Result<RemoteConfig[]>> {
  const args = ["config", "-z", "--get-regexp", "^remote\\..*\\.(url|tagopt)$"];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  // Exit 1 is "no matching key": a repository without remotes.
  if (raw.value.exitCode === 1) return ok([]);
  const checked = requireExit0(raw.value, ["config", "--get-regexp"]);
  if (!checked.ok) return checked;
  const remotes = new Map<string, RemoteConfig>();
  for (const entry of checked.value.stdout.split("\0")) {
    if (entry === "") continue;
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? "" : entry.slice(newline + 1);
    // Remote names may contain dots; the variable is after the last one.
    const dot = key.lastIndexOf(".");
    if (!key.startsWith("remote.") || dot <= 7) continue;
    const name = key.slice(7, dot);
    const variable = key.slice(dot + 1).toLowerCase();
    const remote = remotes.get(name) ?? { name, url: null, tagOpt: null };
    if (variable === "url") remote.url ??= value;
    else if (variable === "tagopt") remote.tagOpt = value;
    remotes.set(name, remote);
  }
  return ok([...remotes.values()].filter((remote) => remote.url !== null));
}

/** Parse `ls-remote --tags`: `<oid>\trefs/tags/<name>` plus `^{}` peel lines. */
export function parseLsRemoteTags(stdout: string): ListedTag[] {
  const tags = new Map<string, ListedTag>();
  const peeled = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const id = line.slice(0, tab).trim();
    const ref = line.slice(tab + 1).trim();
    if (!ref.startsWith("refs/tags/") || !OBJECT_ID.test(id)) continue;
    if (ref.endsWith("^{}")) {
      peeled.set(ref.slice(10, -3), id);
    } else {
      const name = ref.slice(10);
      tags.set(name, { name, objectId: id, targetId: id, annotated: false });
    }
  }
  for (const [name, target] of peeled) {
    const tag = tags.get(name);
    // A peel line means the ref names a tag object.
    if (tag !== undefined) tags.set(name, { ...tag, targetId: target, annotated: true });
  }
  return [...tags.values()];
}

function refuseOptionLike(remote: string): Result<void> {
  if (remote === "" || remote.startsWith("-")) {
    return err({ kind: "repo", code: "invalid_remote", message: `Not a usable remote name: ${remote}` });
  }
  return ok(undefined);
}

/** One full listing of a remote's tags. Protocol v2 sends only `refs/tags/`. */
export async function listRemoteTags(
  git: GitExec,
  cwd: string,
  remote: string
): Promise<Result<ListedTag[]>> {
  const usable = refuseOptionLike(remote);
  if (!usable.ok) return usable;
  const args = ["ls-remote", "--tags", remote];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  return ok(parseLsRemoteTags(checked.value.stdout));
}

export type LocalTagRef = { name: string; objectId: string };

/**
 * Every local tag's name and object id. Name and id only: any field that reads
 * the object (`objecttype`, `*objectname`, `creatordate`) costs ~15x more on
 * 20,000 tags (27ms -> 400ms), and the comparison needs only the id.
 */
export async function readLocalTagRefs(
  git: GitExec,
  cwd: string
): Promise<Result<{ raw: string; tags: LocalTagRef[] }>> {
  const args = ["for-each-ref", "--format=%(objectname) %(refname)", "refs/tags"];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;
  const tags: LocalTagRef[] = [];
  for (const line of checked.value.stdout.split("\n")) {
    const space = line.indexOf(" ");
    const ref = line.slice(space + 1);
    if (space === -1 || !ref.startsWith("refs/tags/")) continue;
    tags.push({ name: ref.slice(10), objectId: line.slice(0, space) });
  }
  return ok({ raw: checked.value.stdout, tags });
}

/** Tag names newest creator date first: the order `repo:tags` pages in. */
async function readTagOrder(git: GitExec, cwd: string): Promise<Result<string[]>> {
  const args = ["for-each-ref", "--sort=refname", "--sort=-creatordate", "--format=%(refname)", "refs/tags"];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;
  return ok(
    checked.value.stdout
      .split("\n")
      .filter((line) => line.startsWith("refs/tags/"))
      .map((line) => line.slice(10))
  );
}

/** Which of these objects exist here, from one `cat-file --batch-check`. */
export async function objectsPresent(
  git: GitExec,
  cwd: string,
  ids: string[]
): Promise<Result<Set<string>>> {
  const unique = [...new Set(ids)].filter((id) => OBJECT_ID.test(id));
  if (unique.length === 0) return ok(new Set());
  const raw = await git(
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    cwd,
    { input: `${unique.join("\n")}\n` }
  );
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["cat-file", "--batch-check"]);
  if (!checked.ok) return checked;
  const present = new Set<string>();
  for (const line of checked.value.stdout.split("\n")) {
    const [id = "", type = ""] = line.trim().split(" ");
    if (type !== "" && type !== "missing") present.add(id);
  }
  return ok(present);
}

async function refObject(git: GitExec, cwd: string, ref: string): Promise<Result<string | null>> {
  const args = ["rev-parse", "--verify", "--quiet", `${ref}^{object}`];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) return ok(null);
  return ok(raw.value.stdout.trim());
}

async function peel(git: GitExec, cwd: string, id: string): Promise<Result<{ targetId: string; annotated: boolean }>> {
  // Line one types the object itself; line two names what it peels to.
  const raw = await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], cwd, { input: `${id}\n${id}^{}\n` });
  if (!raw.ok) return raw;
  const [self = "", peeled = ""] = raw.value.stdout.split("\n");
  const [, selfType = ""] = self.trim().split(" ");
  const [peeledId = "", peeledType = ""] = peeled.trim().split(" ");
  return ok({
    targetId: peeledType !== "" && peeledType !== "missing" && OBJECT_ID.test(peeledId) ? peeledId : id,
    annotated: selfType === "tag"
  });
}

async function updateRefs(git: GitExec, cwd: string, lines: string[]): Promise<Result<void>> {
  // One `update-ref --stdin` is one transaction: every line applies or none.
  const raw = await git(["update-ref", "--stdin"], cwd, { input: `${lines.join("\n")}\n` });
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return err({
      kind: "repo",
      code: "local_tag_changed",
      message: "The local tag changed while PwrGit was updating it. Refresh and review it again.",
      detail: raw.value.stderr.trim()
    });
  }
  return ok(undefined);
}

/** Git stopped by its caller (a cancel, a yield or a timeout), not refused by the remote. */
export function wasStopped(error: { code: string }): boolean {
  return error.code === "aborted" || error.code === "canceled";
}

function zeroLike(id: string): string {
  return "0".repeat(id.length);
}

/** Unique per name: a timestamp segment can repeat only for one name per ms. */
function replacedRefFor(name: string, at: number): string {
  return `${REPLACED_TAG_PREFIX}${at}/${name}`;
}

export async function listReplacedTags(
  git: GitExec,
  cwd: string,
  name: string
): Promise<Result<ReplacedTag[]>> {
  const args = [
    "for-each-ref",
    "--sort=-refname",
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)",
    REPLACED_TAG_PREFIX
  ];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["for-each-ref"]);
  if (!checked.ok) return checked;
  const replaced: ReplacedTag[] = [];
  for (const line of checked.value.stdout.split("\n")) {
    const [ref = "", objectId = "", type = "", peeled = ""] = line.split("\0");
    const match = /^refs\/pwrgit\/replaced-tags\/(\d+)\/(.+)$/.exec(ref);
    if (match === null || match[2] !== name) continue;
    const annotated = type === "tag";
    replaced.push({
      ref,
      objectId,
      targetId: annotated && peeled !== "" ? peeled : objectId,
      kind: annotated ? "annotated" : "lightweight",
      replacedAt: new Date(Number(match[1])).toISOString()
    });
  }
  replaced.sort((a, b) => b.replacedAt.localeCompare(a.replacedAt));
  return ok(replaced);
}

// --------------------------------------------------------------------------
// Comparison (pure)
// --------------------------------------------------------------------------

export type ComparedTag = {
  name: string;
  status: TagSyncStatus;
  local: LocalTagRef | null;
  published: ListedTag | null;
};

export type KeepDecision = { localObjectId: string; remoteObjectId: string };

const versionOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Local tags in their own order, then published-only names newest-version
 * first. `published === null` means the publisher was never listed.
 */
/** One local tag against the publisher's listing (null: never listed). */
function classifyLocal(
  tag: LocalTagRef,
  published: Map<string, ListedTag> | null,
  keeps: Map<string, KeepDecision>
): ComparedTag {
  const remote = published?.get(tag.name) ?? null;
  let status: TagSyncStatus;
  if (published === null) status = "unchecked";
  else if (remote === null) status = "local_only";
  else if (remote.objectId === tag.objectId) status = "same";
  else {
    const keep = keeps.get(tag.name);
    status =
      keep !== undefined &&
      keep.localObjectId === tag.objectId &&
      keep.remoteObjectId === remote.objectId
        ? "kept_local"
        : "differs";
  }
  return { name: tag.name, status, local: tag, published: remote };
}

/** Which rows differ, as one comparable string: names and both object ids. */
function differsSignature(rows: ComparedTag[]): string {
  return rows
    .filter((row) => row.status === "differs")
    .map((row) => `${row.name}\0${row.local?.objectId ?? ""}\0${row.published?.objectId ?? ""}`)
    .sort()
    .join("\n");
}

export function compareTags(
  local: LocalTagRef[],
  published: Map<string, ListedTag> | null,
  keeps: Map<string, KeepDecision>
): { rows: ComparedTag[]; counts: TagStatusCounts } {
  const counts: TagStatusCounts = { all: 0, differs: 0, keptLocal: 0, remoteOnly: 0, localOnly: 0 };
  const rows: ComparedTag[] = [];
  const localNames = new Set<string>();
  for (const tag of local) {
    localNames.add(tag.name);
    rows.push(classifyLocal(tag, published, keeps));
  }
  const remoteOnly = published === null
    ? []
    : [...published.values()]
        .filter((tag) => !localNames.has(tag.name))
        .sort((a, b) => versionOrder.compare(b.name, a.name));
  for (const tag of remoteOnly) {
    rows.push({ name: tag.name, status: "remote_only", local: null, published: tag });
  }
  for (const row of rows) {
    counts.all += 1;
    if (row.status === "differs") counts.differs += 1;
    else if (row.status === "kept_local") counts.keptLocal += 1;
    else if (row.status === "remote_only") counts.remoteOnly += 1;
    else if (row.status === "local_only") counts.localOnly += 1;
  }
  return { rows, counts };
}

function matchesFilter(status: TagSyncStatus, filter: TagStatusFilter): boolean {
  switch (filter) {
    case "differs":
      return status === "differs";
    case "remoteOnly":
      return status === "remote_only";
    case "localOnly":
      return status === "local_only";
    default:
      return true;
  }
}

function remoteValue(remote: string, tag: ListedTag, available?: boolean): RemoteTagValue {
  return {
    remote,
    objectId: tag.objectId,
    targetId: tag.targetId,
    kind: tag.annotated ? "annotated" : "lightweight",
    ...(available === undefined ? {} : { available })
  };
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

type SnapshotRow = {
  remote: string;
  fetch_url: string | null;
  checked_at_ms: number | null;
  attempted_at_ms: number | null;
  error: string | null;
  tag_count: number;
  differs: number;
};

/** SQLite side. Rows are cached per (repo, remote, listing) so paging a
 *  20,000-tag snapshot reads the table once, not once per page. */
export class TagSourceStore {
  private readonly cache = new Map<string, { checkedAt: number; rows: Map<string, ListedTag> }>();

  constructor(private readonly db: DB) {}

  chosenPrimary(repoId: string): string | null {
    const row = this.db
      .prepare("SELECT primary_remote FROM repo_tag_source WHERE repo_id = ?")
      .get(repoId) as { primary_remote: string } | undefined;
    return row?.primary_remote ?? null;
  }

  setPrimary(repoId: string, remote: string): void {
    this.db
      .prepare(
        `INSERT INTO repo_tag_source (repo_id, primary_remote) VALUES (?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET primary_remote = excluded.primary_remote`
      )
      .run(repoId, remote);
  }

  snapshot(repoId: string, remote: string): SnapshotRow | null {
    return (
      (this.db
        .prepare(
          `SELECT remote, fetch_url, checked_at_ms, attempted_at_ms, error, tag_count, differs
           FROM remote_tag_snapshots WHERE repo_id = ? AND remote = ?`
        )
        .get(repoId, remote) as SnapshotRow | undefined) ?? null
    );
  }

  snapshots(repoId: string): SnapshotRow[] {
    return this.db
      .prepare(
        `SELECT remote, fetch_url, checked_at_ms, attempted_at_ms, error, tag_count, differs
         FROM remote_tag_snapshots WHERE repo_id = ?`
      )
      .all(repoId) as SnapshotRow[];
  }

  /** The listing, or null when this remote was never listed successfully. */
  tags(repoId: string, remote: string): Map<string, ListedTag> | null {
    const meta = this.snapshot(repoId, remote);
    if (meta?.checked_at_ms === null || meta === null) return null;
    const key = `${repoId}\0${remote}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.checkedAt === meta.checked_at_ms) return cached.rows;
    const rows = new Map<string, ListedTag>();
    for (const row of this.db
      .prepare(
        "SELECT name, object_id, target_id, annotated FROM remote_tags WHERE repo_id = ? AND remote = ?"
      )
      .iterate(repoId, remote) as Iterable<{ name: string; object_id: string; target_id: string; annotated: number }>) {
      rows.set(row.name, {
        name: row.name,
        objectId: row.object_id,
        targetId: row.target_id,
        annotated: row.annotated === 1
      });
    }
    this.cache.delete(key);
    this.cache.set(key, { checkedAt: meta.checked_at_ms, rows });
    // A few open repositories at most; drop the oldest.
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
    return rows;
  }

  /**
   * Store a successful listing. Writes only the rows that changed, in one
   * transaction, so a re-check of an unchanged 20,000-tag remote writes one row.
   */
  recordListing(repoId: string, remote: string, url: string | null, listed: ListedTag[], at: number): { changed: number } {
    const previous = this.tags(repoId, remote) ?? new Map<string, ListedTag>();
    const next = new Map(listed.map((tag) => [tag.name, tag]));
    const upsert = this.db.prepare(
      `INSERT INTO remote_tags (repo_id, remote, name, object_id, target_id, annotated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, remote, name) DO UPDATE SET
         object_id = excluded.object_id, target_id = excluded.target_id, annotated = excluded.annotated`
    );
    const remove = this.db.prepare("DELETE FROM remote_tags WHERE repo_id = ? AND remote = ? AND name = ?");
    let changed = 0;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO remote_tag_snapshots (repo_id, remote, fetch_url, checked_at_ms, attempted_at_ms, error, tag_count)
           VALUES (?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(repo_id, remote) DO UPDATE SET
             fetch_url = excluded.fetch_url, checked_at_ms = excluded.checked_at_ms,
             attempted_at_ms = excluded.attempted_at_ms, error = NULL, tag_count = excluded.tag_count`
        )
        .run(repoId, remote, url, at, at, next.size);
      for (const tag of next.values()) {
        const old = previous.get(tag.name);
        if (old?.objectId === tag.objectId && old.targetId === tag.targetId && old.annotated === tag.annotated) continue;
        upsert.run(repoId, remote, tag.name, tag.objectId, tag.targetId, tag.annotated ? 1 : 0);
        changed += 1;
      }
      for (const name of previous.keys()) {
        if (next.has(name)) continue;
        remove.run(repoId, remote, name);
        changed += 1;
      }
    })();
    this.cache.set(`${repoId}\0${remote}`, { checkedAt: at, rows: next });
    return { changed };
  }

  recordFailure(repoId: string, remote: string, message: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO remote_tag_snapshots (repo_id, remote, attempted_at_ms, error) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id, remote) DO UPDATE SET attempted_at_ms = excluded.attempted_at_ms, error = excluded.error`
      )
      .run(repoId, remote, at, message);
  }

  /** A removed remote's listing, decisions and publisher choice. */
  forgetRemote(repoId: string, remote: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM remote_tag_snapshots WHERE repo_id = ? AND remote = ?").run(repoId, remote);
      this.db.prepare("DELETE FROM tag_keep_local WHERE repo_id = ? AND remote = ?").run(repoId, remote);
      this.db.prepare("DELETE FROM repo_tag_source WHERE repo_id = ? AND primary_remote = ?").run(repoId, remote);
    })();
    this.cache.delete(`${repoId}\0${remote}`);
  }

  /** Returns true when the stored count moved (the sidebar should re-read). */
  setDiffers(repoId: string, remote: string, differs: number): boolean {
    const result = this.db
      .prepare("UPDATE remote_tag_snapshots SET differs = ? WHERE repo_id = ? AND remote = ? AND differs != ?")
      .run(differs, repoId, remote, differs);
    return result.changes > 0;
  }

  keeps(repoId: string, remote: string): Map<string, KeepDecision> {
    const keeps = new Map<string, KeepDecision>();
    for (const row of this.db
      .prepare("SELECT name, local_object_id, remote_object_id FROM tag_keep_local WHERE repo_id = ? AND remote = ?")
      .all(repoId, remote) as { name: string; local_object_id: string; remote_object_id: string }[]) {
      keeps.set(row.name, { localObjectId: row.local_object_id, remoteObjectId: row.remote_object_id });
    }
    return keeps;
  }

  setKeep(repoId: string, remote: string, name: string, decision: KeepDecision, at: number): void {
    this.db
      .prepare(
        `INSERT INTO tag_keep_local (repo_id, remote, name, local_object_id, remote_object_id, decided_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, remote, name) DO UPDATE SET
           local_object_id = excluded.local_object_id, remote_object_id = excluded.remote_object_id,
           decided_at_ms = excluded.decided_at_ms`
      )
      .run(repoId, remote, name, decision.localObjectId, decision.remoteObjectId, at);
  }

  clearKeep(repoId: string, name: string, remote?: string): void {
    if (remote === undefined) {
      this.db.prepare("DELETE FROM tag_keep_local WHERE repo_id = ? AND name = ?").run(repoId, name);
    } else {
      this.db.prepare("DELETE FROM tag_keep_local WHERE repo_id = ? AND remote = ? AND name = ?").run(repoId, remote, name);
    }
  }

  /**
   * The sidebar's line, from the database only. The publisher is chosen as
   * `TagSources.resolve` chooses it, from the remotes configured now: the
   * chosen remote, else origin, else none.
   */
  attention(repoId: string, remotes: readonly string[]): { remote: string; differs: number } | undefined {
    const remote = this.publisherOf(repoId, remotes);
    if (remote === null) return undefined;
    const meta = this.snapshot(repoId, remote);
    if (meta === null || meta.checked_at_ms === null || meta.differs <= 0) return undefined;
    return { remote, differs: meta.differs };
  }

  /** The publisher as `TagSources.resolve` picks it, from configured remote names. */
  publisherOf(repoId: string, remotes: readonly string[]): string | null {
    const chosen = this.chosenPrimary(repoId);
    return chosen !== null && remotes.includes(chosen) ? chosen : remotes.includes("origin") ? "origin" : null;
  }

  /**
   * The local tags among `local` that differ from the publisher's stored
   * listing, each with the published value: the rows the count line counts,
   * for the surfaces that draw a tag by name (sidebar rows, lineage chips).
   * Database only. A tag kept local, never listed, or listed the same is not
   * here.
   */
  moves(repoId: string, remotes: readonly string[], local: readonly LocalTagRef[]): Map<string, RemoteTagValue> {
    const moved = new Map<string, RemoteTagValue>();
    const remote = this.publisherOf(repoId, remotes);
    if (remote === null || local.length === 0) return moved;
    const published = this.tags(repoId, remote);
    if (published === null) return moved;
    const keeps = this.keeps(repoId, remote);
    for (const tag of local) {
      const row = classifyLocal(tag, published, keeps);
      if (row.status === "differs" && row.published !== null) moved.set(tag.name, remoteValue(remote, row.published));
    }
    return moved;
  }
}

// --------------------------------------------------------------------------
// Service
// --------------------------------------------------------------------------

export type ResolvedSource = {
  state: TagSourceState;
  remote: RemoteConfig | null;
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export class TagSources {
  readonly store: TagSourceStore;
  /** One listing per repository and remote at a time; a second asker shares it. */
  private readonly inFlight = new Map<string, Promise<Result<boolean>>>();
  /**
   * The differing set last recorded per repository and remote. The stored
   * count alone misses a tag that moves while another is taken (10 stays 10),
   * and the sidebar rows and lineage chips draw names, not the count.
   */
  private readonly differing = new Map<string, string>();
  /** Creator-date order per checkout, reused while the name+id listing is unchanged. */
  private readonly orders = new Map<string, { raw: string; tags: LocalTagRef[] }>();

  constructor(db: DB, private readonly now: () => number = Date.now) {
    this.store = new TagSourceStore(db);
  }

  /** Which remote publishes this repository's tags, and how fresh our view is. */
  async source(
    git: GitExec,
    repoId: string,
    cwd: string,
    ttlMs = TAG_SOURCE_VIEW_TTL_MS
  ): Promise<Result<ResolvedSource>> {
    const config = await readRemoteConfig(git, cwd);
    if (!config.ok) return config;
    return ok(this.resolve(repoId, config.value, ttlMs));
  }

  resolve(repoId: string, remotes: RemoteConfig[], ttlMs = TAG_SOURCE_VIEW_TTL_MS): ResolvedSource {
    const chosen = this.store.chosenPrimary(repoId);
    const chosenRemote = chosen === null ? undefined : remotes.find((remote) => remote.name === chosen);
    const remote = chosenRemote ?? remotes.find((candidate) => candidate.name === "origin") ?? null;
    const meta = remote === null ? null : this.store.snapshot(repoId, remote.name);
    const checkedAt = meta?.checked_at_ms ?? null;
    const failedAfter =
      meta !== null && meta.error !== null && (meta.attempted_at_ms ?? 0) >= (checkedAt ?? 0);
    const tagOpt = remote?.tagOpt === "--no-tags" ? "no-tags" : remote?.tagOpt === "--tags" ? "all" : null;
    return {
      remote,
      state: {
        remotes: remotes.map((candidate) => candidate.name),
        primary: remote?.name ?? null,
        chosen: chosenRemote !== undefined,
        tagOpt,
        checkedAt: iso(checkedAt),
        publishedCount: meta?.tag_count ?? 0,
        error: failedAfter ? meta!.error : null,
        stale:
          remote !== null &&
          (checkedAt === null ||
            this.now() - checkedAt > ttlMs ||
            (meta?.fetch_url ?? null) !== remote.url)
      }
    };
  }

  setPrimary(repoId: string, remote: string): void {
    this.store.setPrimary(repoId, remote);
  }

  /**
   * Local tags in the tab's order. The cheap name+id listing runs every time;
   * the creator-date sort, which must read every object, runs only when that
   * listing changed since the last page.
   */
  async orderedLocalTags(git: GitExec, cwd: string): Promise<Result<LocalTagRef[]>> {
    const refs = await readLocalTagRefs(git, cwd);
    if (!refs.ok) return refs;
    const cached = this.orders.get(cwd);
    if (cached !== undefined && cached.raw === refs.value.raw) return ok(cached.tags);
    const order = await readTagOrder(git, cwd);
    if (!order.ok) return order;
    const byName = new Map(refs.value.tags.map((tag) => [tag.name, tag]));
    const tags = order.value.flatMap((name) => {
      const tag = byName.get(name);
      return tag === undefined ? [] : [tag];
    });
    // A tag created between the two reads is still listed, at the end.
    if (tags.length !== byName.size) {
      const seen = new Set(tags.map((tag) => tag.name));
      for (const tag of refs.value.tags) if (!seen.has(tag.name)) tags.push(tag);
    }
    this.orders.delete(cwd);
    this.orders.set(cwd, { raw: refs.value.raw, tags });
    while (this.orders.size > 4) this.orders.delete(this.orders.keys().next().value!);
    return ok(tags);
  }

  /**
   * List one remote's tags into the store (and re-count if it is the
   * publisher). A second asker shares a listing in flight, unless that listing
   * was stopped: a background check yields to a tracked one by aborting, and
   * the tracked caller must not inherit that abort.
   */
  async refresh(git: GitExec, repoId: string, cwd: string, remote: string): Promise<Result<boolean>> {
    const key = `${repoId}\0${remote}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      const shared = await running;
      if (shared.ok || !wasStopped(shared.error)) return shared;
    }
    const run = this.list(git, repoId, cwd, remote);
    this.inFlight.set(key, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }
  }

  /** True when the publisher's differing set moved (its rows need redrawing). */
  private async list(git: GitExec, repoId: string, cwd: string, remote: string): Promise<Result<boolean>> {
    const config = await readRemoteConfig(git, cwd);
    if (!config.ok) return config;
    const target = config.value.find((candidate) => candidate.name === remote);
    if (target === undefined) {
      return err({ kind: "repo", code: "invalid_remote", message: `Not a configured remote: ${remote}` });
    }
    const listed = await listRemoteTags(git, cwd, remote);
    if (!listed.ok) {
      // A stopped listing says nothing about the remote. The caller that set
      // a timeout records that itself (`recordFailure`).
      if (!wasStopped(listed.error)) {
        this.store.recordFailure(repoId, remote, listed.error.message.split("\n")[0] ?? "Listing failed", this.now());
      }
      return listed;
    }
    this.store.recordListing(repoId, remote, target.url, listed.value, this.now());
    const source = this.resolve(repoId, config.value);
    if (source.state.primary === remote) return this.recount(git, repoId, cwd, remote);
    return ok(false);
  }

  /** Re-derive the stored "differs" count; true when it or the differing set moved. */
  async recount(git: GitExec, repoId: string, cwd: string, remote: string): Promise<Result<boolean>> {
    // Never listed: nothing can differ, and no local tag needs reading.
    const published = this.store.tags(repoId, remote);
    if (published === null) return ok(false);
    const local = await readLocalTagRefs(git, cwd);
    if (!local.ok) return local;
    const compared = compareTags(local.value.tags, published, this.store.keeps(repoId, remote));
    return ok(this.recordComparison(repoId, remote, compared));
  }

  /** Store the count and remember the set; true when either moved. */
  private recordComparison(
    repoId: string,
    remote: string,
    compared: { rows: ComparedTag[]; counts: TagStatusCounts }
  ): boolean {
    const countMoved = this.store.setDiffers(repoId, remote, compared.counts.differs);
    const key = `${repoId}\0${remote}`;
    const signature = differsSignature(compared.rows);
    // Unknown after a launch counts as empty: the stored count covers that case.
    const setMoved = (this.differing.get(key) ?? "") !== signature;
    this.differing.set(key, signature);
    return countMoved || setMoved;
  }

  /** The Tags tab. No network; only the requested page's rich rows are read. */
  async statusPage(
    git: GitExec,
    repoId: string,
    cwd: string,
    options: { filter?: TagStatusFilter; query?: string; offset?: number; limit?: number } = {}
  ): Promise<Result<TagStatusPage & { differsChanged: boolean }>> {
    const { filter = "all", query = "", offset = 0, limit = TAG_PAGE_SIZE } = options;
    const start = Number.isSafeInteger(offset) ? Math.min(Math.max(0, offset), 2_147_483_000) : 0;
    const size = Number.isSafeInteger(limit) ? Math.min(Math.max(1, limit), TAG_PAGE_MAX) : TAG_PAGE_SIZE;
    const [config, local] = await Promise.all([readRemoteConfig(git, cwd), this.orderedLocalTags(git, cwd)]);
    if (!config.ok) return config;
    if (!local.ok) return local;
    const { state, remote } = this.resolve(repoId, config.value);
    const published = remote === null ? null : this.store.tags(repoId, remote.name);
    const keeps = remote === null ? new Map<string, KeepDecision>() : this.store.keeps(repoId, remote.name);
    const { rows, counts } = compareTags(local.value, published, keeps);
    const differsChanged =
      remote !== null && published !== null && this.recordComparison(repoId, remote.name, { rows, counts });

    const needle = query.trim().toLowerCase();
    let rich: Map<string, TagSummary> | null = null;
    let matching = rows.filter((row) => matchesFilter(row.status, filter));
    if (needle !== "") {
      // Annotations and taggers are searchable, as on `repo:tags`. Reading
      // every local tag's metadata is that search's cost already.
      const hits = await readAllTagSummaries(git, cwd);
      if (!hits.ok) return hits;
      rich = hits.value;
      matching = matching.filter((row) => {
        if (row.name.toLowerCase().includes(needle)) return true;
        const annotation = rich?.get(row.name)?.annotation;
        return annotation !== undefined &&
          `${annotation.subject} ${annotation.body ?? ""} ${annotation.taggerName ?? ""} ${annotation.taggerEmail ?? ""}`
            .toLowerCase()
            .includes(needle);
      });
    }
    const page = matching.slice(start, start + size);
    if (rich === null) {
      const read = await readTagSummaries(git, cwd, page.filter((row) => row.local !== null).map((row) => row.name));
      if (!read.ok) return read;
      rich = read.value;
    }
    // Only rows that offer an action need to know whether the published
    // objects are here; that is at most one page of ids.
    const needsObjects = page.filter((row) => row.published !== null && row.status !== "same");
    const present = await objectsPresent(git, cwd, needsObjects.map((row) => row.published!.targetId));
    if (!present.ok) return present;
    const pageRows: TagStatusRow[] = page.map((row) => ({
      name: row.name,
      status: row.status,
      local: row.local === null ? null : rich!.get(row.name) ?? null,
      published:
        row.published === null || remote === null
          ? null
          : remoteValue(
              remote.name,
              row.published,
              row.status === "same" ? true : present.value.has(row.published.targetId)
            )
    }));
    return ok({ rows: pageRows, total: matching.length, counts, source: state, differsChanged });
  }

  /**
   * Make refs/tags/<name> the remote's reviewed object. Nothing is written
   * unless the remote still has exactly that object and the local ref still
   * has exactly the reviewed one. The previous local object is pinned under
   * refs/pwrgit/replaced-tags/ in the same transaction, so it is never
   * overwritten without a gc-safe ref to it.
   */
  async adopt(
    git: GitExec,
    repoId: string,
    cwd: string,
    input: {
      name: string;
      remote: string;
      expectedRemoteObjectId: string;
      expectedLocalObjectId: string | null;
    }
  ): Promise<Result<TagAdoptResult>> {
    const valid = await validTagName(git, cwd, input.name);
    if (!valid.ok) return valid;
    const name = valid.value;
    const usable = refuseOptionLike(input.remote);
    if (!usable.ok) return usable;
    const config = await readRemoteConfig(git, cwd);
    if (!config.ok) return config;
    if (!config.value.some((remote) => remote.name === input.remote)) {
      return err({ kind: "repo", code: "invalid_remote", message: `Not a configured remote: ${input.remote}` });
    }
    if (
      !OBJECT_ID.test(input.expectedRemoteObjectId) ||
      (input.expectedLocalObjectId !== null && !OBJECT_ID.test(input.expectedLocalObjectId))
    ) {
      return err({ kind: "repo", code: "invalid_tag_object", message: "Invalid tag object ID" });
    }
    const fullName = `refs/tags/${name}`;
    const current = await refObject(git, cwd, fullName);
    if (!current.ok) return current;
    if (current.value !== input.expectedLocalObjectId) {
      return err({
        kind: "repo",
        code: "local_tag_changed",
        message: `Local ${name} changed after review. Refresh and review it again.`
      });
    }
    const staging = `${INCOMING_TAG_PREFIX}${name}`;
    // `--no-tags`: this one ref, no auto-followed neighbours. No --prune, no
    // FETCH_HEAD, no submodules. The staging ref keeps refs/tags untouched
    // until the fetched object is checked against the review.
    const fetchArgs = [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--",
      input.remote,
      `+${fullName}:${staging}`
    ];
    const fetched = await git(fetchArgs, cwd);
    if (!fetched.ok) return fetched;
    const dropStaging = async (): Promise<void> => {
      await git(["update-ref", "-d", staging], cwd);
    };
    if (fetched.value.exitCode !== 0) {
      await dropStaging();
      const stderr = fetched.value.stderr.trim();
      return err({
        kind: "remote",
        code: /couldn't find remote ref/i.test(stderr) ? "remote_tag_missing" : "fetch_failed",
        message: /couldn't find remote ref/i.test(stderr)
          ? `${input.remote} no longer has ${name}. Refresh to see its current tags.`
          : `Fetching ${name} from ${input.remote} failed.`,
        detail: stderr
      });
    }
    const arrived = await refObject(git, cwd, staging);
    if (!arrived.ok) {
      await dropStaging();
      return arrived;
    }
    if (arrived.value !== input.expectedRemoteObjectId) {
      await dropStaging();
      return err({
        kind: "remote",
        code: "remote_tag_changed",
        message: `${input.remote}'s ${name} changed since it was checked. Refresh and review it again.`
      });
    }
    const target = await peel(git, cwd, arrived.value);
    if (!target.ok) {
      await dropStaging();
      return target;
    }
    let replacedRef: string | null = null;
    if (current.value !== null) {
      const next = await this.nextReplacedRef(git, cwd, name);
      if (!next.ok) {
        await dropStaging();
        return next;
      }
      replacedRef = next.value;
    }
    const id = arrived.value;
    const written = await updateRefs(git, cwd, [
      ...(replacedRef === null ? [] : [`create ${replacedRef} ${current.value}`]),
      `update ${fullName} ${id} ${current.value ?? zeroLike(id)}`,
      `delete ${staging} ${id}`
    ]);
    if (!written.ok) {
      await dropStaging();
      return written;
    }
    this.store.clearKeep(repoId, name);
    await this.recountPublisher(git, repoId, cwd);
    return ok({ name, objectId: id, targetId: target.value.targetId, replacedRef });
  }

  /** A free refs/pwrgit/replaced-tags/<ms>/<name>: now, or the next unused millisecond. */
  private async nextReplacedRef(git: GitExec, cwd: string, name: string): Promise<Result<string>> {
    const existing = await listReplacedTags(git, cwd, name);
    if (!existing.ok) return existing;
    const taken = new Set(existing.value.map((tag) => tag.ref));
    let at = this.now();
    while (taken.has(replacedRefFor(name, at))) at += 1;
    return ok(replacedRefFor(name, at));
  }

  /** Put a replaced value back, pinning the current one the same way first. */
  async restore(
    git: GitExec,
    repoId: string,
    cwd: string,
    input: { name: string; ref: string; expectedLocalObjectId: string | null }
  ): Promise<Result<TagAdoptResult>> {
    const valid = await validTagName(git, cwd, input.name);
    if (!valid.ok) return valid;
    const name = valid.value;
    const match = /^refs\/pwrgit\/replaced-tags\/\d+\/(.+)$/.exec(input.ref);
    if (match === null || match[1] !== name) {
      return err({ kind: "repo", code: "invalid_tag", message: "Not a replaced value of this tag" });
    }
    const fullName = `refs/tags/${name}`;
    const [kept, current] = await Promise.all([refObject(git, cwd, input.ref), refObject(git, cwd, fullName)]);
    if (!kept.ok) return kept;
    if (!current.ok) return current;
    if (kept.value === null) {
      return err({ kind: "repo", code: "not_found", message: "That replaced value is gone." });
    }
    if (current.value !== input.expectedLocalObjectId) {
      return err({ kind: "repo", code: "local_tag_changed", message: `Local ${name} changed after review. Refresh and review it again.` });
    }
    // Read before the write: once the refs move, an error here would report
    // a restore that already happened as failed.
    const target = await peel(git, cwd, kept.value);
    if (!target.ok) return target;
    let replacedRef: string | null = null;
    if (current.value !== null) {
      const next = await this.nextReplacedRef(git, cwd, name);
      if (!next.ok) return next;
      replacedRef = next.value;
    }
    const written = await updateRefs(git, cwd, [
      ...(replacedRef === null ? [] : [`create ${replacedRef} ${current.value}`]),
      `update ${fullName} ${kept.value} ${current.value ?? zeroLike(kept.value)}`,
      // The tag ref now keeps the object alive; the pin has done its job.
      `delete ${input.ref} ${kept.value}`
    ]);
    if (!written.ok) return written;
    this.store.clearKeep(repoId, name);
    await this.recountPublisher(git, repoId, cwd);
    return ok({ name, objectId: kept.value, targetId: target.value.targetId, replacedRef });
  }

  /** Record (or drop) Keep local for exactly this pair of objects. */
  async keepLocal(
    git: GitExec,
    repoId: string,
    cwd: string,
    input: { name: string; remote: string; localObjectId: string; remoteObjectId: string; keep: boolean }
  ): Promise<Result<void>> {
    const valid = await validTagName(git, cwd, input.name);
    if (!valid.ok) return valid;
    if (!input.keep) {
      this.store.clearKeep(repoId, valid.value, input.remote);
      return ok(undefined);
    }
    if (!OBJECT_ID.test(input.localObjectId) || !OBJECT_ID.test(input.remoteObjectId)) {
      return err({ kind: "repo", code: "invalid_tag_object", message: "Invalid tag object ID" });
    }
    const config = await readRemoteConfig(git, cwd);
    if (!config.ok) return config;
    if (!config.value.some((remote) => remote.name === input.remote)) {
      return err({ kind: "repo", code: "invalid_remote", message: `Not a configured remote: ${input.remote}` });
    }
    this.store.setKeep(repoId, input.remote, valid.value, {
      localObjectId: input.localObjectId,
      remoteObjectId: input.remoteObjectId
    }, this.now());
    return ok(undefined);
  }

  async recountPublisher(git: GitExec, repoId: string, cwd: string): Promise<Result<boolean>> {
    const source = await this.source(git, repoId, cwd);
    if (!source.ok) return source;
    if (source.value.remote === null) return ok(false);
    return this.recount(git, repoId, cwd, source.value.remote.name);
  }

  /** Every source's own value for one name. Runs no network command. */
  async details(git: GitExec, repoId: string, cwd: string, rawName: string): Promise<Result<TagDetails>> {
    const valid = await validTagName(git, cwd, rawName);
    if (!valid.ok) return valid;
    const name = valid.value;
    const [config, local, replaced] = await Promise.all([
      readRemoteConfig(git, cwd),
      readTagSummaries(git, cwd, [name]),
      listReplacedTags(git, cwd, name)
    ]);
    if (!config.ok) return config;
    if (!local.ok) return local;
    if (!replaced.ok) return replaced;
    const { state } = this.resolve(repoId, config.value);
    const values = config.value.map((remote) => {
      const meta = this.store.snapshot(repoId, remote.name);
      const tag = this.store.tags(repoId, remote.name)?.get(name) ?? null;
      return { remote: remote.name, meta, tag };
    });
    const present = await objectsPresent(
      git,
      cwd,
      values.flatMap((value) => (value.tag === null ? [] : [value.tag.targetId]))
    );
    if (!present.ok) return present;
    return ok({
      name,
      local: local.value.get(name) ?? null,
      remotes: values
        .map((value) => ({
          remote: value.remote,
          published: value.remote === state.primary,
          checkedAt: iso(value.meta?.checked_at_ms ?? null),
          value:
            value.tag === null
              ? null
              : remoteValue(value.remote, value.tag, present.value.has(value.tag.targetId))
        }))
        // The publisher first, then the rest by name.
        .sort((a, b) => Number(b.published) - Number(a.published) || a.remote.localeCompare(b.remote)),
      replaced: replaced.value
    });
  }
}

const services = new WeakMap<DB, TagSources>();

/** One service per database, shared by the tag, remote and branch handlers. */
export function tagSourcesFor(db: DB): TagSources {
  let service = services.get(db);
  if (service === undefined) {
    service = new TagSources(db);
    services.set(db, service);
  }
  return service;
}
