import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { bulkSyncRepositories } from "./bulk-sync";
import type { GitExec } from "./dugite";
import {
  fetchAllRemotes,
  fetchNamedRemote,
  fetchNamedRemotes,
  fetchRemote,
  pullFastForward
} from "./git-service";
import { readGraphTags } from "./graph-tags";
import { compareTags, parseLsRemoteTags, TagSources, type ListedTag } from "./tag-sources";
import { createSystemGit } from "./test-support/system-git";

const roots: string[] = [];
const dbs: DB[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const systemGit = createSystemGit({ env });

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    cwd: tmpdir(), env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function exists(root: string, id: string): boolean {
  try {
    git(root, "cat-file", "-e", id);
    return true;
  } catch {
    return false;
  }
}

function identity(repo: string): void {
  git(repo, "config", "user.name", "Tag Fixture");
  git(repo, "config", "user.email", "tags@example.test");
  git(repo, "config", "maintenance.auto", "false");
  git(repo, "config", "core.autocrlf", "false");
}

function commit(repo: string, file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-m", text.trim());
  return git(repo, "rev-parse", "HEAD");
}

/** Re-cut `name` on the publisher's remote: delete, re-create at HEAD, push. */
function recut(publisher: string, name: string, annotated: boolean, at = "HEAD"): void {
  git(publisher, "push", "origin", `:refs/tags/${name}`);
  git(publisher, "tag", "-d", name);
  git(publisher, "tag", ...(annotated ? ["-a", "-m", `Re-cut ${name}`] : []), name, at);
  git(publisher, "push", "origin", `refs/tags/${name}`);
}

/**
 * origin.git, a publisher clone, and the user's clone. The user's v1.2.3 is
 * the original cut; origin's is a re-cut at a newer commit that the user's
 * branch already has, so no branch counter can signal the change.
 */
function fixture(annotated = true) {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-tag-sources-"));
  roots.push(root);
  git(root, "init", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "origin.git", "publisher");
  const publisher = join(root, "publisher");
  identity(publisher);
  const oldHead = commit(publisher, "release.txt", "original release\n");
  git(publisher, "tag", ...(annotated ? ["-a", "-m", "Release"] : []), "v1.2.3");
  git(publisher, "push", "-u", "origin", "main", "--tags");
  git(root, "clone", "origin.git", "local");
  const local = join(root, "local");
  identity(local);
  const newHead = commit(publisher, "release.txt", "reissued release\n");
  git(publisher, "push", "origin", "main");
  git(local, "pull", "--ff-only");
  recut(publisher, "v1.2.3", annotated);
  git(local, "tag", "local-only", oldHead);
  const oldObject = git(local, "rev-parse", "v1.2.3");
  return { root, publisher, local, oldHead, newHead, oldObject };
}

function service(now = () => Date.now()): { db: DB; sources: TagSources } {
  const db = openDatabase(":memory:");
  dbs.push(db);
  db.prepare("INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')").run();
  db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('repo-1', 'p1', 'proj', '/x')").run();
  return { db, sources: new TagSources(db, now) };
}

async function page(sources: TagSources, local: string, filter?: "all" | "differs" | "remoteOnly" | "localOnly") {
  const result = await sources.statusPage(systemGit, "repo-1", local, filter === undefined ? {} : { filter });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function counting(calls: string[][], timings?: string[]): GitExec {
  return async (args, cwd, options) => {
    calls.push(args);
    const started = performance.now();
    const result = await systemGit(args, cwd, options);
    timings?.push(`${args.slice(0, 2).join(" ")} ${(performance.now() - started).toFixed(0)}ms`);
    return result;
  };
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parsing and comparing", () => {
  it("reads peel lines as annotation and keeps lightweight tags as-is", () => {
    const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
    expect(parseLsRemoteTags(`${a}\trefs/tags/v1\n${b}\trefs/tags/v1^{}\n${c}\trefs/tags/v2\n${a}\trefs/heads/main\n`)).toEqual([
      { name: "v1", objectId: a, targetId: b, annotated: true },
      { name: "v2", objectId: c, targetId: c, annotated: false }
    ]);
  });

  it("classifies every pair, honours an exact keep, and orders published-only names by version", () => {
    const tag = (name: string, id: string): ListedTag => ({ name, objectId: id.repeat(40), targetId: id.repeat(40), annotated: false });
    const local = [tag("v2", "a"), tag("v1", "b"), tag("mine", "c"), tag("kept", "d")];
    const published = new Map([tag("v2", "a"), tag("v1", "e"), tag("kept", "f"), tag("v10", "1"), tag("v9", "2")].map((t) => [t.name, t]));
    const keeps = new Map([["kept", { localObjectId: "d".repeat(40), remoteObjectId: "f".repeat(40) }]]);
    const { rows, counts } = compareTags(local, published, keeps);
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["v2", "same"], ["v1", "differs"], ["mine", "local_only"], ["kept", "kept_local"],
      ["v10", "remote_only"], ["v9", "remote_only"]
    ]);
    expect(counts).toEqual({ all: 6, differs: 1, keptLocal: 1, remoteOnly: 2, localOnly: 1 });
    // A keep is for one exact pair: the remote moving again asks again.
    const moved = new Map(published);
    moved.set("kept", tag("kept", "9"));
    expect(compareTags(local, moved, keeps).rows.find((row) => row.name === "kept")?.status).toBe("differs");
    expect(compareTags(local, null, keeps).rows.every((row) => row.status === "unchecked")).toBe(true);
  });
});

describe("ordinary sync never rewrites an existing tag", () => {
  for (const annotated of [false, true]) {
    it(`Fetch, Pull, Fetch all and Bulk sync leave a re-cut ${annotated ? "annotated" : "lightweight"} tag alone, and the graph still reads Git`, async () => {
      const { local, oldHead, newHead } = fixture(annotated);
      for (const run of [
        () => fetchRemote(systemGit, local),
        () => fetchNamedRemote(systemGit, local, "origin"),
        () => fetchNamedRemotes(systemGit, local, ["origin"]),
        () => fetchAllRemotes(systemGit, local),
        () => pullFastForward(systemGit, local)
      ]) {
        expect((await run()).ok).toBe(true);
        expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(oldHead);
      }
      const bulk = await bulkSyncRepositories(systemGit, [
        { id: "repo", name: "Tag fixture", path: local, worktrees: [{ id: "main", branch: "main", path: local }] }
      ], { operationId: "tags", mode: "fetch" });
      expect(bulk.counts.remotes.fetched).toBe(1);
      expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(oldHead);
      expect(git(local, "rev-parse", "HEAD")).toBe(newHead);
      const graph = await readGraphTags(systemGit, local);
      expect(graph.ok && graph.value[oldHead]?.name).toBeTruthy();
    });
  }
});

describe("published tags", () => {
  it("first run: shows the pre-existing mismatch, adopts only on request, and keeps the old value gc-safe and restorable", async () => {
    const { local, oldHead, newHead, oldObject } = fixture(true);
    const { sources } = service();

    // Never listed: nothing is compared, nothing is changed.
    const before = await page(sources, local);
    expect(before.source).toMatchObject({ primary: "origin", chosen: false, checkedAt: null, stale: true });
    expect(before.rows.every((row) => row.status === "unchecked")).toBe(true);

    expect((await sources.refresh(systemGit, "repo-1", local, "origin")).ok).toBe(true);
    expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(oldHead);
    const listed = await page(sources, local);
    expect(listed.source).toMatchObject({ primary: "origin", publishedCount: 1, stale: false, error: null });
    expect(listed.counts).toMatchObject({ differs: 1, localOnly: 1, remoteOnly: 0 });
    const row = listed.rows.find((candidate) => candidate.name === "v1.2.3")!;
    expect(row.status).toBe("differs");
    expect(row.local?.targetId).toBe(oldHead);
    expect(row.published).toMatchObject({ remote: "origin", targetId: newHead, kind: "annotated", available: true });
    expect(listed.rows.find((candidate) => candidate.name === "local-only")?.status).toBe("local_only");
    expect(sources.store.attention("repo-1", ["origin"])).toEqual({ remote: "origin", differs: 1 });

    const adopted = await sources.adopt(systemGit, "repo-1", local, {
      name: "v1.2.3",
      remote: "origin",
      expectedRemoteObjectId: row.published!.objectId,
      expectedLocalObjectId: row.local!.objectId
    });
    if (!adopted.ok) throw new Error(adopted.error.message);
    expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(newHead);
    expect(git(local, "rev-parse", "local-only")).toBe(oldHead);
    expect(adopted.value.replacedRef).toMatch(/^refs\/pwrgit\/replaced-tags\/\d+\/v1\.2\.3$/);
    expect(git(local, "rev-parse", adopted.value.replacedRef!)).toBe(oldObject);
    expect(git(local, "for-each-ref", "refs/pwrgit/incoming-tags")).toBe("");
    expect((await page(sources, local)).counts.differs).toBe(0);
    expect(sources.store.attention("repo-1", ["origin"])).toBeUndefined();

    // The pin is a real ref: an aggressive gc keeps the replaced tag object.
    git(local, "reflog", "expire", "--expire=now", "--all");
    git(local, "gc", "--prune=now", "--quiet");
    expect(exists(local, oldObject)).toBe(true);

    const details = await sources.details(systemGit, "repo-1", local, "v1.2.3");
    if (!details.ok) throw new Error(details.error.message);
    expect(details.value.replaced).toHaveLength(1);
    const restored = await sources.restore(systemGit, "repo-1", local, {
      name: "v1.2.3",
      ref: details.value.replaced[0]!.ref,
      expectedLocalObjectId: adopted.value.objectId
    });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(git(local, "rev-parse", "v1.2.3")).toBe(oldObject);
    const after = await sources.details(systemGit, "repo-1", local, "v1.2.3");
    expect(after.ok && after.value.replaced.map((tag) => tag.objectId)).toEqual([adopted.value.objectId]);
  });

  it("Keep local quiets exactly one pair of objects", async () => {
    const { local, publisher } = fixture(false);
    const { sources } = service();
    await sources.refresh(systemGit, "repo-1", local, "origin");
    const row = (await page(sources, local, "differs")).rows[0]!;
    const refused = await sources.keepLocal(systemGit, "repo-1", local, {
      name: row.name, remote: "gone", localObjectId: row.local!.objectId, remoteObjectId: row.published!.objectId, keep: true
    });
    expect(refused.ok ? null : refused.error.code).toBe("invalid_remote");
    const short = await sources.keepLocal(systemGit, "repo-1", local, {
      name: row.name, remote: "origin", localObjectId: row.local!.objectId.slice(0, 12), remoteObjectId: row.published!.objectId, keep: true
    });
    expect(short.ok ? null : short.error.code).toBe("invalid_tag_object");
    const recorded = await sources.keepLocal(systemGit, "repo-1", local, {
      name: row.name, remote: "origin", localObjectId: row.local!.objectId, remoteObjectId: row.published!.objectId, keep: true
    });
    expect(recorded.ok).toBe(true);
    const kept = await page(sources, local);
    expect(kept.rows.find((candidate) => candidate.name === "v1.2.3")?.status).toBe("kept_local");
    expect(kept.counts).toMatchObject({ differs: 0, keptLocal: 1 });
    commit(publisher, "release.txt", "third cut\n");
    git(publisher, "push", "origin", "main");
    recut(publisher, "v1.2.3", false);
    await sources.refresh(systemGit, "repo-1", local, "origin");
    expect((await page(sources, local)).rows.find((candidate) => candidate.name === "v1.2.3")?.status).toBe("differs");
  });

  it("a lightweight tag re-cut as annotated at the same commit differs, and adopting changes its kind", async () => {
    const { local, publisher, newHead } = fixture(false);
    const { sources } = service();
    git(local, "fetch", "origin", "+refs/tags/v1.2.3:refs/tags/v1.2.3");
    recut(publisher, "v1.2.3", true);
    await sources.refresh(systemGit, "repo-1", local, "origin");
    const row = (await page(sources, local)).rows.find((candidate) => candidate.name === "v1.2.3")!;
    expect(row.status).toBe("differs");
    expect(row.local).toMatchObject({ kind: "lightweight", targetId: newHead });
    expect(row.published).toMatchObject({ kind: "annotated", targetId: newHead });
    const adopted = await sources.adopt(systemGit, "repo-1", local, {
      name: "v1.2.3", remote: "origin", expectedRemoteObjectId: row.published!.objectId, expectedLocalObjectId: row.local!.objectId
    });
    expect(adopted.ok).toBe(true);
    expect(git(local, "cat-file", "-t", "v1.2.3")).toBe("tag");
  });

  it("the published remote decides; another remote's same name is kept apart and never rewrites the tag", async () => {
    const { root, local, publisher, oldHead, newHead } = fixture(true);
    git(local, "fetch", "origin", "+refs/tags/v1.2.3:refs/tags/v1.2.3");
    git(root, "init", "--bare", "-b", "main", "upstream.git");
    git(publisher, "remote", "add", "upstream", join(root, "upstream.git"));
    git(publisher, "push", "upstream", "main");
    git(publisher, "tag", "-f", "v1.2.3", oldHead);
    git(publisher, "push", "upstream", "refs/tags/v1.2.3");
    git(local, "remote", "add", "upstream", join(root, "upstream.git"));
    expect((await fetchNamedRemote(systemGit, local, "upstream")).ok).toBe(true);
    expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(newHead);

    const { sources } = service();
    await sources.refresh(systemGit, "repo-1", local, "origin");
    await sources.refresh(systemGit, "repo-1", local, "upstream");
    const byOrigin = await page(sources, local);
    expect(byOrigin.source.primary).toBe("origin");
    expect(byOrigin.rows.find((row) => row.name === "v1.2.3")?.status).toBe("same");

    const details = await sources.details(systemGit, "repo-1", local, "v1.2.3");
    if (!details.ok) throw new Error(details.error.message);
    expect(details.value.remotes.map((remote) => [remote.remote, remote.published, remote.value?.targetId, remote.value?.kind])).toEqual([
      ["origin", true, newHead, "annotated"],
      ["upstream", false, oldHead, "lightweight"]
    ]);
    expect(details.value.local?.targetId).toBe(newHead);

    sources.setPrimary("repo-1", "upstream");
    const byUpstream = await page(sources, local);
    expect(byUpstream.source).toMatchObject({ primary: "upstream", chosen: true });
    expect(byUpstream.rows.find((row) => row.name === "v1.2.3")?.status).toBe("differs");
  });

  it("lists a tag-only history without downloading it, and downloads only the one tag asked for", async () => {
    const { local, publisher } = fixture(true);
    git(publisher, "checkout", "--orphan", "legacy");
    git(publisher, "rm", "-rf", "--quiet", ".");
    const orphan = commit(publisher, "legacy.txt", "imported history\n");
    git(publisher, "tag", "-a", "-m", "Legacy import", "legacy/import");
    const other = commit(publisher, "legacy.txt", "more imported history\n");
    git(publisher, "tag", "legacy/other");
    git(publisher, "push", "origin", "refs/tags/legacy/import", "refs/tags/legacy/other");

    expect((await fetchRemote(systemGit, local)).ok).toBe(true);
    expect(exists(local, orphan)).toBe(false);

    const { sources } = service();
    await sources.refresh(systemGit, "repo-1", local, "origin");
    expect(exists(local, orphan)).toBe(false);
    const remoteOnly = await page(sources, local, "remoteOnly");
    expect(remoteOnly.rows.map((row) => [row.name, row.local, row.published?.available])).toEqual([
      ["legacy/other", null, false],
      ["legacy/import", null, false]
    ]);
    const row = remoteOnly.rows[1]!;
    const downloaded = await sources.adopt(systemGit, "repo-1", local, {
      name: "legacy/import", remote: "origin", expectedRemoteObjectId: row.published!.objectId, expectedLocalObjectId: null
    });
    if (!downloaded.ok) throw new Error(downloaded.error.message);
    expect(downloaded.value.replacedRef).toBeNull();
    expect(git(local, "rev-parse", "legacy/import^{}")).toBe(orphan);
    // `--no-tags`: the neighbouring tag-only history stayed on the remote.
    expect(exists(local, other)).toBe(false);
    expect(git(local, "tag", "--list", "legacy/other")).toBe("");
  });

  it("honours tagOpt=--no-tags: Fetch adds no tags, and the state says so", async () => {
    const { local, publisher } = fixture(true);
    git(local, "config", "remote.origin.tagOpt", "--no-tags");
    commit(publisher, "release.txt", "v3\n");
    git(publisher, "tag", "v3.0.0");
    git(publisher, "push", "origin", "main", "refs/tags/v3.0.0");
    expect((await fetchRemote(systemGit, local)).ok).toBe(true);
    expect(git(local, "tag", "--list", "v3.0.0")).toBe("");
    const { sources } = service();
    expect((await page(sources, local)).source).toMatchObject({ primary: "origin", tagOpt: "no-tags" });
    // An explicit check is still allowed, and changes no ref.
    expect((await sources.refresh(systemGit, "repo-1", local, "origin")).ok).toBe(true);
    expect(git(local, "tag", "--list", "v3.0.0")).toBe("");
    expect((await page(sources, local, "remoteOnly")).rows.map((row) => row.name)).toEqual(["v3.0.0"]);
  });

  it("refuses when either side moved after review, and leaves no partial refs", async () => {
    const { local, publisher, oldHead, oldObject } = fixture(true);
    const { sources } = service();
    await sources.refresh(systemGit, "repo-1", local, "origin");
    const row = (await page(sources, local, "differs")).rows[0]!;
    commit(publisher, "release.txt", "yet another cut\n");
    git(publisher, "push", "origin", "main");
    recut(publisher, "v1.2.3", true);
    const remoteMoved = await sources.adopt(systemGit, "repo-1", local, {
      name: "v1.2.3", remote: "origin", expectedRemoteObjectId: row.published!.objectId, expectedLocalObjectId: row.local!.objectId
    });
    expect(!remoteMoved.ok && remoteMoved.error.code).toBe("remote_tag_changed");
    const localMoved = await sources.adopt(systemGit, "repo-1", local, {
      name: "v1.2.3", remote: "origin", expectedRemoteObjectId: row.published!.objectId, expectedLocalObjectId: "f".repeat(40)
    });
    expect(!localMoved.ok && localMoved.error.code).toBe("local_tag_changed");
    expect(git(local, "rev-parse", "v1.2.3")).toBe(oldObject);
    expect(git(local, "rev-parse", "v1.2.3^{}")).toBe(oldHead);
    expect(git(local, "for-each-ref", "refs/pwrgit")).toBe("");
  });

  it("with no origin nothing is published until a remote is chosen", async () => {
    const { local } = fixture(true);
    git(local, "remote", "rename", "origin", "github");
    const { sources } = service();
    const unset = await page(sources, local);
    expect(unset.source).toMatchObject({ primary: null, remotes: ["github"], stale: false });
    expect(unset.rows.every((row) => row.status === "unchecked")).toBe(true);
    sources.setPrimary("repo-1", "github");
    expect((await page(sources, local)).source).toMatchObject({ primary: "github", chosen: true, stale: true });
  });
});

describe("listing lifecycle", () => {
  it("a stopped listing records no failure, and an asker joining it lists again", async () => {
    const { local } = fixture(false);
    const { sources } = service();
    // Stops at ls-remote, the way a background check yields to a user's Fetch.
    const controller = new AbortController();
    const stopAtListing: GitExec = (args, cwd, options) => {
      if (args[0] === "ls-remote") controller.abort();
      return systemGit(args, cwd, { ...options, signal: controller.signal });
    };
    const stopped = await sources.refresh(stopAtListing, "repo-1", local, "origin");
    expect(stopped.ok ? null : stopped.error.code).toBe("aborted");
    expect(sources.store.snapshot("repo-1", "origin")).toBeNull();

    const second = new AbortController();
    const yielding: GitExec = (args, cwd, options) => {
      if (args[0] === "ls-remote") second.abort();
      return systemGit(args, cwd, { ...options, signal: second.signal });
    };
    const background = sources.refresh(yielding, "repo-1", local, "origin");
    const explicit = sources.refresh(systemGit, "repo-1", local, "origin");
    expect((await background).ok).toBe(false);
    const answered = await explicit;
    expect(answered.ok).toBe(true);
    expect(sources.store.snapshot("repo-1", "origin")).toMatchObject({ error: null, tag_count: 1 });
  });

  it("re-counting a remote that was never listed reads no local tag", async () => {
    const { local } = fixture(false);
    const { sources } = service();
    const calls: string[][] = [];
    const recount = await sources.recount(counting(calls), "repo-1", local, "origin");
    expect(recount.ok && recount.value).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a restore that cannot read the kept value moves no ref", async () => {
    const { local } = fixture(false);
    const { sources } = service();
    expect((await sources.refresh(systemGit, "repo-1", local, "origin")).ok).toBe(true);
    const row = (await page(sources, local, "differs")).rows[0]!;
    const adopted = await sources.adopt(systemGit, "repo-1", local, {
      name: "v1.2.3",
      remote: "origin",
      expectedRemoteObjectId: row.published!.objectId,
      expectedLocalObjectId: row.local!.objectId
    });
    if (!adopted.ok) throw new Error(adopted.error.message);
    // The object read fails, as a stopped or failed spawn would.
    const noObjectReads: GitExec = (args, cwd, options) =>
      args[0] === "cat-file"
        ? Promise.resolve({ ok: false, error: { kind: "git", code: "spawn_failed", message: "cat-file failed" } })
        : systemGit(args, cwd, options);
    const restored = await sources.restore(noObjectReads, "repo-1", local, {
      name: "v1.2.3",
      ref: adopted.value.replacedRef!,
      expectedLocalObjectId: adopted.value.objectId
    });
    expect(restored.ok).toBe(false);
    // Reported failed, so nothing may have moved: the tag and its pin stay.
    expect(git(local, "rev-parse", "v1.2.3")).toBe(adopted.value.objectId);
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/pwrgit/replaced-tags")).toBe(adopted.value.replacedRef);
  });

  it("the sidebar line follows the configured remotes, and a removed remote is forgotten", () => {
    const { sources } = service();
    const tag = { name: "v1", objectId: "a".repeat(40), targetId: "a".repeat(40), annotated: false };
    sources.store.recordListing("repo-1", "upstream", "/up.git", [tag], 1);
    sources.store.setDiffers("repo-1", "upstream", 2);
    sources.setPrimary("repo-1", "upstream");
    expect(sources.store.attention("repo-1", ["origin", "upstream"])).toEqual({ remote: "upstream", differs: 2 });
    // upstream removed outside PwrGit: origin publishes now, as the tab says.
    expect(sources.store.attention("repo-1", ["origin"])).toBeUndefined();
    sources.store.forgetRemote("repo-1", "upstream");
    expect(sources.store.chosenPrimary("repo-1")).toBeNull();
    expect(sources.store.snapshot("repo-1", "upstream")).toBeNull();
    expect(sources.store.tags("repo-1", "upstream")).toBeNull();
  });
});

describe("cost on a 20,000-tag remote", () => {
  it("lists in one process, re-lists without rewriting, pages without per-tag Git, and finds an old moved tag", async () => {
    const { root, local, publisher, newHead } = fixture(false);
    git(local, "fetch", "origin", "+refs/tags/*:refs/tags/*");
    const archive = commit(publisher, "archive.txt", "archive\n");
    git(publisher, "push", "origin", "main");
    git(local, "pull", "--ff-only");
    git(local, "pack-refs", "--all");
    const names = Array.from({ length: 20_000 }, (_, index) => `archive-${String(index).padStart(5, "0")}`);
    const refLines = (id: string) => names.map((name) => `${id} refs/tags/${name}`);
    const merge = (path: string, extra: string[]) => {
      const existing = readFileSync(path, "utf8").split("\n").filter((line) => line !== "" && !line.startsWith("#"));
      const byRef = new Map([...existing, ...extra].map((line) => [line.slice(41), line]));
      writeFileSync(path, `${[...byRef.values()].sort((a, b) => (a.slice(41) < b.slice(41) ? -1 : 1)).join("\n")}\n`);
    };
    // Packed refs written directly: 40,000 loose ref files would spend most of
    // a Windows CI run in the filesystem, not in what this test measures.
    git(join(root, "origin.git"), "pack-refs", "--all");
    merge(join(root, "origin.git", "packed-refs"), refLines(archive));
    merge(join(local, ".git", "packed-refs"), refLines(archive));

    const now = { value: Date.now() };
    const { sources } = service(() => now.value);
    const calls: string[][] = [];
    const timings: string[] = [];
    const tracedGit = counting(calls, timings);
    let started = performance.now();
    expect((await sources.refresh(tracedGit, "repo-1", local, "origin")).ok).toBe(true);
    const firstMs = performance.now() - started;
    expect(calls.filter((args) => args[0] === "ls-remote")).toHaveLength(1);
    expect(calls.length).toBeLessThanOrEqual(4);
    const listing = await systemGit(["ls-remote", "--tags", "origin"], local);
    const lsBytes = listing.ok ? Buffer.byteLength(listing.value.stdout) : 0;

    now.value += 1;
    calls.length = 0;
    started = performance.now();
    const rows = sources.store.recordListing("repo-1", "origin", null, [...sources.store.tags("repo-1", "origin")!.values()], now.value);
    const rewriteMs = performance.now() - started;
    expect(rows.changed).toBe(0);
    // The first write of a 20,000-row snapshot, alone: it runs on main's thread.
    const fresh = service();
    started = performance.now();
    fresh.sources.store.recordListing("repo-1", "origin", null, [...sources.store.tags("repo-1", "origin")!.values()], now.value);
    const firstWriteMs = performance.now() - started;

    calls.length = 0;
    started = performance.now();
    const first = await sources.statusPage(tracedGit, "repo-1", local);
    const pageMs = performance.now() - started;
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.rows).toHaveLength(50);
    expect(first.value.counts).toMatchObject({ all: 20_002, differs: 0 });
    // config + name/id listing + the order + the page's rich rows: no per-tag loop.
    expect(calls.length).toBeLessThanOrEqual(5);
    const coldTimings = timings.splice(0).filter((line) => line.startsWith("for-each-ref"));
    const coldCalls = calls.length;

    // The next page reuses the creator-date order: the local listing is unchanged.
    calls.length = 0;
    started = performance.now();
    const second = await sources.statusPage(tracedGit, "repo-1", local, { offset: 50 });
    const warmMs = performance.now() - started;
    expect(second.ok && second.value.rows[0]?.name).not.toBe(first.value.rows[0]?.name);
    expect(calls.filter((args) => args.includes("--sort=-creatordate"))).toHaveLength(0);

    // An old tag moving on origin is found by the next listing: no cap.
    git(join(root, "origin.git"), "update-ref", "refs/tags/archive-00007", newHead);
    now.value += 1;
    expect((await sources.refresh(systemGit, "repo-1", local, "origin")).ok).toBe(true);
    const moved = await page(sources, local, "differs");
    expect(moved.rows.map((row) => row.name)).toEqual(["archive-00007"]);

    console.info(
      `[tag-sources cost] 20,002 tags: first listing+store ${firstMs.toFixed(0)}ms ` +
      `(ls-remote output ${(lsBytes / 1024).toFixed(0)} KiB), first SQLite write ${firstWriteMs.toFixed(0)}ms, unchanged re-store ${rewriteMs.toFixed(0)}ms, ` +
      `first page ${pageMs.toFixed(0)}ms with ${coldCalls} Git processes (${coldTimings.map((line) => line.replace(/--format=.*? /, "")).join(", ")}), ` +
      `next page ${warmMs.toFixed(0)}ms with ${calls.length}`
    );
  }, 60_000);
});
