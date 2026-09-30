import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openDatabase, type DB } from "./db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "../git/repo-indexer";
import { createSystemGit } from "../git/test-support/system-git";

// 0037 moves the search rows out of the fts5 table into an ordinary indexed
// table, and turns the fts5 table into an external-content index over it.
// Two things can go wrong that no `:memory:` suite can see: rows present
// before the upgrade not surviving it, and the index drifting from its rows
// once the old triggers start writing the new table. Both are staged here.

const MIGRATIONS = join(__dirname, "migrations");
const UPGRADE = "0037_search_rows_indexed.sql";
const container = mkdtempSync(join(tmpdir(), "pwrgit-search-rows-"));

afterAll(() => rmSync(container, { recursive: true, force: true }));

const kinds = (db: DB): unknown[] =>
  db
    .prepare("SELECT kind, COUNT(*) AS n FROM search_fts GROUP BY kind ORDER BY kind")
    .all();

/** fts5 compares an external-content index with its rows; throws on drift. */
const checkIndex = (db: DB): void => {
  db.prepare(
    "INSERT INTO search_fts_index (search_fts_index) VALUES ('integrity-check')"
  ).run();
};

it("carries every row across, and keeps the index true to its rows", () => {
  const dir = join(container, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(MIGRATIONS)) {
    if (file < UPGRADE) cpSync(join(MIGRATIONS, file), join(dir, file));
  }
  const dbPath = join(container, "app.db");

  const before = openDatabase(dbPath, dir);
  const profile = new ProfileService(before).create({
    name: "Ours",
    email: "ours@example.com",
    roots: []
  });
  before
    .prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
    .run("repo-1", profile.id, "deploy-tools", "/checkouts/deploy-tools");
  before
    .prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 1)"
    )
    .run("wt-1", "repo-1", "main", "/checkouts/deploy-tools/main");
  before
    .prepare(
      "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES (?, ?, ?, ?)"
    )
    .run("lb-1", "repo-1", "feat/rebuild", "refs/heads/feat/rebuild");
  before
    .prepare(
      "INSERT INTO remote_branches (id, repo_id, remote_name, name, full_name) VALUES (?, ?, 'origin', ?, ?)"
    )
    .run("rb-1", "repo-1", "feat/remote", "refs/remotes/origin/feat/remote");
  before
    .prepare(
      `INSERT INTO repo_open_pr
         (repo_id, number, url, title, state, is_draft, forge, host, repo_path, head_ref, base_ref)
       VALUES (?, 106, 'https://example.com/pull/106', 'feat: rebuild the console',
               'open', 0, 'github', 'github.com', 'octo/orbit', 'feat/rebuild', 'main')`
    )
    .run("repo-1");
  const kindsBefore = kinds(before);
  expect(kindsBefore).toHaveLength(5);
  before.close();

  for (const file of readdirSync(MIGRATIONS)) {
    if (file >= UPGRADE) cpSync(join(MIGRATIONS, file), join(dir, file));
  }
  const after = openDatabase(dbPath, dir);
  try {
    expect(kinds(after)).toEqual(kindsBefore);
    checkIndex(after);

    const indexer = new RepoIndexer(after, createSystemGit());
    const scope = { profileId: profile.id, allProfiles: false };
    const names = (query: string): string[] =>
      indexer.searchAll(query, scope).map((hit) => `${hit.kind}:${hit.name}`);
    expect(indexer.searchAll("deploy-tools", scope)[0]?.kind).toBe("repo");
    expect(
      indexer.searchAll("106", scope).some((hit) => hit.pr?.number === 106)
    ).toBe(true);

    // The pre-existing triggers now write the plain table. Each kind of write
    // has to reach the index: an insert is found, an update is found by its
    // new text and not its old, and a delete is found by nothing.
    after
      .prepare(
        "INSERT INTO remote_branches (id, repo_id, remote_name, name, full_name) VALUES (?, ?, 'origin', ?, ?)"
      )
      .run("rb-2", "repo-1", "fix/quartz", "refs/remotes/origin/fix/quartz");
    expect(names("quartz")).toContain("remote_branch:fix/quartz");

    after
      .prepare("UPDATE remote_branches SET name = ?, full_name = ? WHERE id = ?")
      .run("fix/granite", "refs/remotes/origin/fix/granite", "rb-2");
    expect(names("granite")).toContain("remote_branch:fix/granite");
    expect(names("quartz")).toEqual([]);

    after.prepare("UPDATE repos SET name = ? WHERE id = ?").run("ship-tools", "repo-1");
    expect(indexer.searchAll("ship-tools", scope)[0]?.kind).toBe("repo");

    after.prepare("DELETE FROM remote_branches WHERE id = ?").run("rb-2");
    expect(names("granite")).toEqual([]);
    checkIndex(after);

    // A repo's cascade takes every row it owns out of both.
    after.prepare("DELETE FROM repos WHERE id = ?").run("repo-1");
    expect(kinds(after)).toEqual([]);
    expect(names("rebuild")).toEqual([]);
    checkIndex(after);
  } finally {
    after.close();
  }
});
