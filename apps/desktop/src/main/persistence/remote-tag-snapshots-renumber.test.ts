import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./db";

const MIGRATIONS = join(__dirname, "migrations");
const RENUMBERED = "0047_remote_tag_snapshots.sql";
const FORMER = "0045_remote_tag_snapshots.sql";

it("opens a database that ran the tag migration under its former number, keeping its rows", () => {
  const container = mkdtempSync(join(tmpdir(), "pwrgit-tag-renumber-"));
  const dir = join(container, "migrations");
  mkdirSync(dir);
  try {
    // The branch's earlier layout: the tag tables as 0045, beside main's files.
    for (const file of readdirSync(MIGRATIONS)) {
      cpSync(join(MIGRATIONS, file), join(dir, file === RENUMBERED ? FORMER : file));
    }
    const path = join(container, "app.db");
    let db = openDatabase(path, dir);
    db.prepare("INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')").run();
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('r1', 'p1', 'proj', '/proj')").run();
    db.prepare("INSERT INTO repo_tag_source (repo_id, primary_remote) VALUES ('r1', 'upstream')").run();
    db.close();

    // Today's layout: the same file as 0047, which this database has not run.
    rmSync(join(dir, FORMER));
    cpSync(join(MIGRATIONS, RENUMBERED), join(dir, RENUMBERED));
    db = openDatabase(path, dir);
    try {
      expect(db.prepare("SELECT primary_remote FROM repo_tag_source WHERE repo_id = 'r1'").get())
        .toEqual({ primary_remote: "upstream" });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE name LIKE '%remote_tag_snapshots%' ORDER BY name").all())
        .toEqual([{ name: FORMER }, { name: RENUMBERED }]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});
