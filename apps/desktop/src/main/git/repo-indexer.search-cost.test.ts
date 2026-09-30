import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "./repo-indexer";
import { createSystemGit } from "./test-support/system-git";

// Every table the ⌘K index mirrors keeps it current through triggers, and
// each trigger finds its search row by (kind, entity_id). Those writes run on
// the main process, inside better-sqlite3's synchronous calls. When that
// lookup was a scan of the FTS table, every branch a fetch added or pruned
// cost one pass over the whole index: ~3.7ms per row against a real profile
// of 24,321 remote branches, so a 100-row write chunk held the event loop for
// ~400ms and deleting a repository with 6,672 remote branches froze the app
// for ~25s in a single statement.
//
// These tests stage that shape — a large index already present, then one
// repository's worth of branch churn — and bound how long the main thread is
// held. The bounds are an order of magnitude above the indexed cost, and an
// order of magnitude below the scanning one.

/** Search rows already in the index: the PwrDrvr profile's remote branches. */
const INDEXED_ROWS = 24_000;
/** Remote branches the churned repository carries. */
const REPO_BRANCHES = 1_000;

// Address the repo with `-C` from a directory nobody removes: on Windows a
// descendant git.exe can still hold its native cwd after the launcher exits,
// and afterAll's rmSync then fails (see this directory's AGENTS.md).
function git(dir: string, args: string[], input?: string): void {
  execFileSync("git", ["-C", dir, ...args], {
    cwd: tmpdir(),
    stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
    ...(input === undefined ? {} : { input })
  });
}

/** Point `count` remote-tracking refs, starting at `from`, at HEAD. */
function remoteRefs(dir: string, from: number, count: number, verb: string): void {
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { cwd: tmpdir() })
    .toString()
    .trim();
  const lines: string[] = [];
  for (let i = from; i < from + count; i++) {
    const ref = `refs/remotes/origin/feature/branch-${String(i).padStart(5, "0")}`;
    lines.push(verb === "delete" ? `delete ${ref}` : `create ${ref} ${head}`);
  }
  git(dir, ["update-ref", "--stdin"], `${lines.join("\n")}\n`);
}

let root: string;
let db: DB;
let indexer: RepoIndexer;
let profileId: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pwrgit-search-cost-"));
  db = openDatabase(":memory:");
  profileId = new ProfileService(db).create({
    name: "Large",
    email: "large@example.com",
    roots: []
  }).id;
  // The rest of the profile, written straight into the index: what matters is
  // how many rows a trigger's lookup has to get past, not which repo owns them.
  const insert = db.prepare(
    `INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
     VALUES (?, 'remote_branch', ?, ?, 'elsewhere', NULL, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < INDEXED_ROWS; i++) {
      const name = `topic/work-item-${i}`;
      insert.run(`other:${i}`, name, `refs/remotes/origin/${name}`, profileId);
    }
  })();
}, 60_000);

afterAll(() => {
  db?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("search index writes against a large index", () => {
  it("looks a search row up by index, never by scanning the index", () => {
    for (const sql of [
      "DELETE FROM search_fts WHERE entity_id = ? AND kind = 'remote_branch'",
      "UPDATE search_fts SET name = 'renamed' WHERE entity_id = ? AND kind = 'worktree'"
    ]) {
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("id") as { detail: string }[]
      ).map((row) => row.detail);
      expect(plan.join("\n"), sql).not.toMatch(/\bSCAN search_fts\b/);
    }
  });

  it("keeps a fetch's branch-index refresh from holding the main process", async () => {
    const repo = join(root, "large-repo");
    git(tmpdir(), ["init", "-q", "-b", "main", repo]);
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "Tester"]);
    writeFileSync(join(repo, "README.md"), "# repo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["remote", "add", "origin", "https://example.com/large.git"]);
    remoteRefs(repo, 0, REPO_BRANCHES, "create");

    indexer = new RepoIndexer(db, createSystemGit());
    const indexed = await indexer.indexRepoAt(profileId, repo);
    expect(indexed.ok).toBe(true);
    if (!indexed.ok) return;

    // A fetch like the one that froze the app: new branches arrive, and
    // `--prune` drops some that merged.
    remoteRefs(repo, REPO_BRANCHES, 500, "create");
    remoteRefs(repo, 0, 144, "delete");

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const refreshed = await indexer.refreshRepoRemoteBranches(indexed.value.id);
    delay.disable();
    expect(refreshed.ok).toBe(true);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM remote_branches WHERE repo_id = ?")
        .get(indexed.value.id)
    ).toEqual({ n: REPO_BRANCHES + 500 - 144 });
    // The histogram records how late each 10ms tick fired: the longest time
    // any one synchronous stretch kept the loop from running.
    expect(delay.max / 1e6).toBeLessThan(100);
  }, 60_000);

  it("removes a repository and its index rows in one short statement", () => {
    const row = db
      .prepare("SELECT id FROM repos WHERE name = 'large-repo'")
      .get() as { id: string } | undefined;
    // Indexed by the refresh test above; without it there is nothing to time.
    expect(row, "the refresh test did not index large-repo").toBeDefined();
    if (row === undefined) return;
    const repoId = row.id;
    const started = performance.now();
    db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
    const elapsed = performance.now() - started;
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM search_fts WHERE entity_id LIKE ?")
        .get(`${repoId}:%`)
    ).toEqual({ n: 0 });
    // The cascade fires the delete trigger once per remote branch.
    expect(elapsed).toBeLessThan(250);
  });
});
