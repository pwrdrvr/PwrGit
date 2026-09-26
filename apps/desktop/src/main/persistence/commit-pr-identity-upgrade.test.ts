import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./db";

const MIGRATIONS = join(__dirname, "migrations");
const UPGRADE = "0034_commit_pr_repository_identity.sql";

it("invalidates old GitHub associations across profiles once, preserving other caches", () => {
  const container = mkdtempSync(join(tmpdir(), "pwrgit-pr-upgrade-"));
  const dir = join(container, "migrations");
  mkdirSync(dir);
  for (const file of readdirSync(MIGRATIONS)) {
    if (file < UPGRADE) cpSync(join(MIGRATIONS, file), join(dir, file));
  }
  const path = join(container, "app.db");
  let db = openDatabase(path, dir);
  try {
    for (const profile of ["one", "two"]) {
      db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)")
        .run(profile, profile, `${profile}@example.com`);
      db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
        .run(profile, profile, "project", `/${profile}`);
      for (const forge of ["github", "gitlab", null]) {
        db.prepare(`INSERT INTO commit_pr (repo_id, commit_sha, number, forge, repo_path, state)
          VALUES (?, ?, 3, ?, 'fork/project', 'merged')`).run(profile, `${forge}`, forge);
      }
      db.prepare("INSERT INTO branch_pr (repo_id, branch, number, forge) VALUES (?, 'feature', 3, 'github')").run(profile);
    }
    db.close();
    cpSync(join(MIGRATIONS, UPGRADE), join(dir, UPGRADE));
    db = openDatabase(path, dir);
    expect(db.prepare("SELECT repo_id, forge FROM commit_pr ORDER BY repo_id").all()).toEqual([
      { repo_id: "one", forge: "gitlab" }, { repo_id: "two", forge: "gitlab" }
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM branch_pr").get()).toEqual({ n: 2 });
    db.prepare(`INSERT INTO commit_pr (repo_id, commit_sha, number, forge, repo_path)
      VALUES ('one', 'corrected', 3, 'github', 'upstream/project')`).run();
    db.close();
    db = openDatabase(path, dir);
    expect(db.prepare("SELECT repo_path FROM commit_pr WHERE commit_sha = 'corrected'").get())
      .toEqual({ repo_path: "upstream/project" });
  } finally {
    db.close();
    rmSync(container, { recursive: true, force: true });
  }
});
