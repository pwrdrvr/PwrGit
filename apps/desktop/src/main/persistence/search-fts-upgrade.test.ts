import { cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./db";
import { ProfileService } from "../profiles/profile-service";
import { RepoIndexer } from "../git/repo-indexer";
import { createSystemGit } from "../git/test-support/system-git";

// 0033 rebuilds search_fts to add profile_id, and its backfill is the only
// part of it that an ordinary test cannot reach: every other suite opens
// `:memory:`, where all the migrations run against empty tables and the
// INSERT…SELECT statements copy nothing. Upgrading a database that already
// holds rows is the case every existing installation actually takes, so it is
// staged here: migrate to 0032, fill it, then let 0033 run.

const MIGRATIONS = join(__dirname, "migrations");
const UPGRADE = "0033_search_profile_scope.sql";
const container = mkdtempSync(join(tmpdir(), "pwrgit-fts-upgrade-"));

it("carries every indexed row through the profile-scope rebuild", () => {
  const dir = join(container, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(MIGRATIONS)) {
    if (file !== UPGRADE) cpSync(join(MIGRATIONS, file), join(dir, file));
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
  const kindsBefore = before
    .prepare("SELECT kind, COUNT(*) AS n FROM search_fts GROUP BY kind ORDER BY kind")
    .all();
  expect(kindsBefore).toHaveLength(5);
  before.close();

  cpSync(join(MIGRATIONS, UPGRADE), join(dir, UPGRADE));
  const after = openDatabase(dbPath, dir);
  try {
    // Every row came back, under the profile that owns it.
    expect(
      after
        .prepare("SELECT kind, COUNT(*) AS n FROM search_fts GROUP BY kind ORDER BY kind")
        .all()
    ).toEqual(kindsBefore);
    expect(
      after
        .prepare("SELECT COUNT(*) AS n FROM search_fts WHERE profile_id = ?")
        .get(profile.id)
    ).toEqual({ n: 5 });

    // And the index still answers — including the PR text a search row only
    // carries because the backfill rebuilt it from branch_pr and repo_open_pr.
    const indexer = new RepoIndexer(after, createSystemGit());
    const scope = { profileId: profile.id, allProfiles: false };
    expect(indexer.searchAll("rebuild", scope).length).toBeGreaterThan(0);
    expect(
      indexer.searchAll("106", scope).some((hit) => hit.pr?.number === 106)
    ).toBe(true);
    expect(indexer.searchAll("deploy-tools", scope)[0]?.kind).toBe("repo");
  } finally {
    after.close();
  }
});
