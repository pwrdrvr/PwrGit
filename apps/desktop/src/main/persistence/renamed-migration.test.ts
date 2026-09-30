import { cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./db";

// The fork-source migration was built on a branch as 0036 and landed as 0038,
// after main shipped its own 0036 and 0037. A database opened on that branch
// recorded the old name and already has the columns; opening it on the
// renamed tree must not run the ALTERs again.

const MIGRATIONS = join(__dirname, "migrations");
const CURRENT = "0038_worktree_fork_source.sql";
const OLD = "0036_worktree_fork_source.sql";

it("skips a renamed migration that a database already ran under its old name", () => {
  const container = mkdtempSync(join(tmpdir(), "pwrgit-renamed-migration-"));
  const branchDir = join(container, "branch-migrations");
  mkdirSync(branchDir, { recursive: true });
  // The tree as that branch had it: everything before, plus the migration
  // under its old name.
  for (const file of readdirSync(MIGRATIONS)) {
    if (file < "0036") cpSync(join(MIGRATIONS, file), join(branchDir, file));
  }
  cpSync(join(MIGRATIONS, CURRENT), join(branchDir, OLD));
  const dbPath = join(container, "app.db");
  openDatabase(dbPath, branchDir).close();

  const db = openDatabase(dbPath, MIGRATIONS);
  const names = (
    db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]
  ).map((r) => r.name);
  const columns = (
    db.prepare("SELECT name FROM pragma_table_info('worktree_state')").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  db.close();

  expect(names).toEqual(expect.arrayContaining([OLD, CURRENT]));
  expect(columns).toEqual(
    expect.arrayContaining(["source_remote", "source_behind", "upstream_gone"])
  );
});
