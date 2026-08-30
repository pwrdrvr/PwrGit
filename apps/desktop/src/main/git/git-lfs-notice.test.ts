import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitLfsStatus } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import { recordLfsOutcome } from "./git-lfs-notice";

const READY: GitLfsStatus = {
  required: true,
  installed: true,
  configured: true,
  version: "git-lfs/3.7.1"
};
const BROKEN: GitLfsStatus = {
  required: true,
  installed: false,
  configured: false
};

function seed(db: DB): void {
  db.prepare(
    "INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')"
  ).run();
  db.prepare(
    `INSERT INTO repos (id, profile_id, name, path)
     VALUES ('repo-1', 'p1', 'proj', '/repos/proj')`
  ).run();
}

let db: DB;

beforeEach(() => {
  db = openDatabase(":memory:");
  seed(db);
});

afterEach(() => {
  db.close();
});

describe("recordLfsOutcome", () => {
  it("announces a working setup once per repo, surviving restarts", () => {
    // The one test where the file is load-bearing: a relaunch reopens the
    // same database file, and "once" must hold across it.
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "pwrgit-lfs-notice-")),
      "app.db"
    );
    let fileDb = openDatabase(dbPath);
    try {
      seed(fileDb);
      expect(recordLfsOutcome(fileDb, "repo-1", READY)).toBe(true);
      expect(recordLfsOutcome(fileDb, "repo-1", READY)).toBe(false);

      fileDb.close();
      fileDb = openDatabase(dbPath);
      expect(recordLfsOutcome(fileDb, "repo-1", READY)).toBe(false);
    } finally {
      fileDb.close();
    }
  });

  it("never announces a broken setup, but re-announces the repair", () => {
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(true);
    expect(recordLfsOutcome(db, "repo-1", BROKEN)).toBe(false);
    expect(recordLfsOutcome(db, "repo-1", BROKEN)).toBe(false);
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(true);
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(false);
  });

  it("treats a first-seen broken setup as broken, not as a fresh repair", () => {
    expect(recordLfsOutcome(db, "repo-1", BROKEN)).toBe(false);
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(true);
  });

  it("leaves the record alone for a checkout without LFS rules", () => {
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(true);
    // A branch without LFS attributes says nothing about the repo's setup —
    // switching through one must not reset the announcement.
    expect(recordLfsOutcome(db, "repo-1", { required: false })).toBe(false);
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(false);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM repo_lfs_notice").get()
    ).toEqual({ n: 1 });
  });

  it("keeps repos' records independent", () => {
    db.prepare(
      `INSERT INTO repos (id, profile_id, name, path)
       VALUES ('repo-2', 'p1', 'other', '/repos/other')`
    ).run();
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(true);
    expect(recordLfsOutcome(db, "repo-2", READY)).toBe(true);
    expect(recordLfsOutcome(db, "repo-1", READY)).toBe(false);
  });
});
