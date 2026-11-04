import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./db";

const MIGRATIONS = join(__dirname, "migrations");
const UPGRADE = "0043_branch_pr_source_identity.sql";

it("revalidates legacy GitHub branch matches across profiles once, retaining exact-commit history", () => {
  const container = mkdtempSync(join(tmpdir(), "pwrgit-branch-pr-upgrade-"));
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
        .run(profile, profile, "codex", `/${profile}`);
      for (const forge of ["github", "gitlab", "gitcafe", null]) {
        db.prepare(`INSERT INTO branch_pr (repo_id, branch, number, forge, state)
          VALUES (?, ?, 14495, ?, 'merged')`).run(profile, `${forge}`, forge);
      }
      db.prepare(`INSERT INTO commit_pr (repo_id, commit_sha, number, forge, repo_path, state)
        VALUES (?, 'inherited', 14495, 'github', 'openai/codex', 'merged')`).run(profile);
    }
    db.close();
    for (const file of readdirSync(MIGRATIONS)) {
      if (file >= UPGRADE) cpSync(join(MIGRATIONS, file), join(dir, file));
    }
    db = openDatabase(path, dir);
    expect(db.prepare("SELECT repo_id, forge FROM branch_pr ORDER BY repo_id, forge").all()).toEqual([
      { repo_id: "one", forge: "gitcafe" }, { repo_id: "one", forge: "gitlab" },
      { repo_id: "two", forge: "gitcafe" }, { repo_id: "two", forge: "gitlab" }
    ]);
    expect(db.prepare("SELECT repo_id, repo_path FROM commit_pr ORDER BY repo_id").all()).toEqual([
      { repo_id: "one", repo_path: "openai/codex" }, { repo_id: "two", repo_path: "openai/codex" }
    ]);
    db.prepare(`INSERT INTO branch_pr (repo_id, branch, number, forge)
      VALUES ('one', 'corrected', 20, 'github')`).run();
    db.close();
    db = openDatabase(path, dir);
    expect(db.prepare("SELECT number FROM branch_pr WHERE branch = 'corrected'").get()).toEqual({ number: 20 });
  } finally {
    db.close();
    rmSync(container, { recursive: true, force: true });
  }
});
