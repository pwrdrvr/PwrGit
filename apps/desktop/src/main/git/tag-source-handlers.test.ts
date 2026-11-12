import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import { registerBulkSyncHandlers } from "./bulk-sync-handlers";
import { registerRemoteHandlers } from "./remote-handlers";
import { tagAutoChecksFor } from "./tag-auto-check";
import { registerTagHandlers } from "./tag-handlers";
import { tagSourcesFor } from "./tag-sources";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const roots: string[] = [];
let db: DB;
let bus: CommandBus;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    cwd: tmpdir(), env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

/** origin with v1.0.0 re-cut after the user cloned it. */
function fixture(): { local: string; oldHead: string; newHead: string } {
  const root = mkdtempSync(join(tmpdir(), "pwrgit-tag-handlers-"));
  roots.push(root);
  git(root, "init", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "origin.git", "publisher");
  const publisher = join(root, "publisher");
  for (const repo of [publisher]) {
    git(repo, "config", "user.name", "Tag Fixture");
    git(repo, "config", "user.email", "tags@example.test");
  }
  writeFileSync(join(publisher, "a.txt"), "one\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-m", "one");
  const oldHead = git(publisher, "rev-parse", "HEAD");
  git(publisher, "tag", "v1.0.0");
  git(publisher, "push", "origin", "main", "--tags");
  git(root, "clone", "origin.git", "local");
  writeFileSync(join(publisher, "a.txt"), "two\n");
  git(publisher, "commit", "-am", "two");
  const newHead = git(publisher, "rev-parse", "HEAD");
  git(publisher, "tag", "-f", "v1.0.0");
  git(publisher, "push", "origin", "main", "+refs/tags/v1.0.0");
  return { local: join(root, "local"), oldHead, newHead };
}

function register(path: string): void {
  db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('repo-1', 'p1', 'proj', ?)").run(path);
  const refresher = {
    refreshWorktree: vi.fn(async () => undefined),
    refreshRepoWorktrees: vi.fn()
  } satisfies WorktreeRefresher;
  const queue = new WorktreeOperationQueue();
  registerRemoteHandlers(bus, db, refresher, queue);
  registerBulkSyncHandlers(bus, db, refresher, queue);
  registerTagHandlers(bus, db);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare("INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')").run();
  bus = new CommandBus();
  vi.mocked(emitEvent).mockClear();
});

afterEach(() => {
  db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("published tag handlers", () => {
  it("checks automatically only when stale, and adopting a tag repaints the graph", async () => {
    const { local, oldHead, newHead } = fixture();
    register(local);

    const first = await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "auto" });
    expect(first.ok && first.value).toMatchObject({ checked: true, source: { primary: "origin", stale: false } });
    // Fresh: opening the tab again asks the remote nothing.
    const again = await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "auto" });
    expect(again.ok && again.value.checked).toBe(false);

    const status = await bus.dispatch("repo:tagStatus", { repoId: "repo-1", filter: "differs" });
    if (!status.ok) throw new Error(status.error.message);
    const row = status.value.rows[0]!;
    expect(row).toMatchObject({ name: "v1.0.0", status: "differs" });
    expect(row.local?.targetId).toBe(oldHead);

    vi.mocked(emitEvent).mockClear();
    const adopted = await bus.dispatch("tag:adoptRemote", {
      repoId: "repo-1",
      name: "v1.0.0",
      remote: "origin",
      expectedRemoteObjectId: row.published!.objectId,
      expectedLocalObjectId: row.local!.objectId
    });
    expect(adopted.ok).toBe(true);
    expect(git(local, "rev-parse", "v1.0.0")).toBe(newHead);
    // A tag-only change moves no branch counter, so the graph is told directly.
    expect(emitEvent).toHaveBeenCalledWith("graph:changed", { repoId: "repo-1" });
    expect(emitEvent).toHaveBeenCalledWith("repo:changed", { profileId: "p1", repoIds: ["repo-1"] });
  });

  it("never lists a remote with tagOpt=--no-tags on its own, but does when asked", async () => {
    const { local } = fixture();
    git(local, "config", "remote.origin.tagOpt", "--no-tags");
    register(local);
    const auto = await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "auto" });
    expect(auto.ok && auto.value).toMatchObject({ checked: false, source: { tagOpt: "no-tags", checkedAt: null } });
    const explicit = await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "explicit" });
    expect(explicit.ok && explicit.value.checked).toBe(true);
    expect(explicit.ok && explicit.value.source.checkedAt).not.toBeNull();
  });

  it("a successful Fetch takes a first snapshot in the background, and the sidebar count follows", async () => {
    const { local } = fixture();
    register(local);
    expect((await bus.dispatch("remote:fetchRepo", { repoId: "repo-1", remote: "origin" })).ok).toBe(true);
    const sources = tagSourcesFor(db);
    await vi.waitFor(() => expect(sources.store.snapshot("repo-1", "origin")?.checked_at_ms).toBeTypeOf("number"), { timeout: 10_000 });
    await vi.waitFor(() => expect(sources.store.attention("repo-1", ["origin"])).toEqual({ remote: "origin", differs: 1 }));
    // The fetch itself changed no tag.
    expect(git(local, "tag", "--points-at", "HEAD")).toBe("v1.0.0");
  });

  it("re-counts when a local tag is created or deleted, and forgets a removed remote", async () => {
    const { local, oldHead } = fixture();
    register(local);
    expect((await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "explicit" })).ok).toBe(true);
    const sources = tagSourcesFor(db);
    expect(sources.store.attention("repo-1", ["origin"])).toEqual({ remote: "origin", differs: 1 });

    const deleted = await bus.dispatch("tag:deleteLocal", {
      repoId: "repo-1",
      name: "v1.0.0",
      expectedObjectId: git(local, "rev-parse", "v1.0.0")
    });
    expect(deleted.ok).toBe(true);
    expect(sources.store.attention("repo-1", ["origin"])).toBeUndefined();

    const created = await bus.dispatch("tag:create", {
      repoId: "repo-1",
      name: "v1.0.0",
      targetCommit: oldHead,
      kind: "lightweight"
    });
    expect(created.ok).toBe(true);
    expect(sources.store.attention("repo-1", ["origin"])).toEqual({ remote: "origin", differs: 1 });

    expect((await bus.dispatch("remote:remove", { repoId: "repo-1", remote: "origin" })).ok).toBe(true);
    expect(sources.store.snapshot("repo-1", "origin")).toBeNull();
  });

  it("a Fetch within the hour re-counts the sidebar line after a terminal moved a tag", async () => {
    const { local, newHead } = fixture();
    register(local);
    expect((await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "explicit" })).ok).toBe(true);
    const sources = tagSourcesFor(db);
    expect(sources.store.attention("repo-1", ["origin"])).toEqual({ remote: "origin", differs: 1 });
    // The user takes origin's value outside PwrGit; the listing is still fresh.
    git(local, "fetch", "origin", "+refs/tags/v1.0.0:refs/tags/v1.0.0");
    expect(git(local, "rev-parse", "v1.0.0")).toBe(newHead);
    expect((await bus.dispatch("remote:fetchRepo", { repoId: "repo-1", remote: "origin" })).ok).toBe(true);
    await vi.waitFor(() => expect(sources.store.attention("repo-1", ["origin"])).toBeUndefined(), { timeout: 10_000 });
  });

  it("a failing remote's back-off does not hold back another publisher", async () => {
    const { local } = fixture();
    const origin = git(local, "remote", "get-url", "origin");
    git(local, "remote", "add", "mirror", origin);
    git(local, "remote", "set-url", "origin", join(tmpdir(), "pwrgit-missing-remote.git"));
    register(local);
    const failed = await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "auto" });
    expect(failed.ok && failed.value).toMatchObject({ checked: false, source: { primary: "origin" } });
    expect((await bus.dispatch("tag:setPrimaryRemote", { repoId: "repo-1", remote: "mirror" })).ok).toBe(true);
    const mirror = await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "auto" });
    expect(mirror.ok && mirror.value).toMatchObject({ checked: true, source: { primary: "mirror", stale: false } });
  });

  it("a bulk or timed sync checks tags as a toolbar Fetch does", async () => {
    const { local } = fixture();
    register(local);
    // Bulk sync reads worktree rows; the primary checkout is enough.
    db.prepare("INSERT INTO worktrees (id, repo_id, path, branch, is_primary) VALUES ('wt-1', 'repo-1', ?, 'main', 1)").run(local);
    const synced = await bus.dispatch("remote:bulkSync", { operationId: "op-1", profileId: "p1", mode: "fetch" });
    expect(synced.ok).toBe(true);
    const sources = tagSourcesFor(db);
    await vi.waitFor(() => expect(sources.store.attention("repo-1", ["origin"])).toEqual({ remote: "origin", differs: 1 }), { timeout: 10_000 });
  });

  it("with the sync menu's switch off, no Fetch, Pull or bulk sync checks tags", async () => {
    const { local } = fixture();
    register(local);
    db.prepare("INSERT INTO worktrees (id, repo_id, path, branch, is_primary) VALUES ('wt-1', 'repo-1', ?, 'main', 1)").run(local);
    tagAutoChecksFor(db).afterSyncWhen(() => false);
    // Switched off, `afterSync` returns before queuing anything, and both
    // handlers call it before they answer: no call now means none later.
    const sources = tagSourcesFor(db);
    const read = vi.spyOn(sources, "source");
    const recount = vi.spyOn(sources, "recountPublisher");
    expect((await bus.dispatch("remote:fetchRepo", { repoId: "repo-1", remote: "origin" })).ok).toBe(true);
    expect((await bus.dispatch("remote:bulkSync", { operationId: "op-2", profileId: "p1", mode: "fetch" })).ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(recount).not.toHaveBeenCalled();
    read.mockRestore();
    recount.mockRestore();
    expect(sources.store.snapshot("repo-1", "origin")).toBeNull();
    // The Tags tab's own check does not depend on the switch.
    const view = await bus.dispatch("tag:refreshRemote", { repoId: "repo-1", mode: "auto" });
    expect(view.ok && view.value.checked).toBe(true);
  });

  it("refuses an unconfigured remote as the publisher", async () => {
    const { local } = fixture();
    register(local);
    const refused = await bus.dispatch("tag:setPrimaryRemote", { repoId: "repo-1", remote: "nope" });
    expect(!refused.ok && refused.error.code).toBe("invalid_remote");
  });
});
