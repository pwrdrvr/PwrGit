import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDatabase, type DB } from "./db";

const MIGRATIONS = join(__dirname, "migrations");
const UPGRADE = "0049_commit_author_signature.sql";
const FETCHED = 1_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

let container: string;
let dir: string;
let path: string;
let db: DB;

beforeEach(() => {
  container = mkdtempSync(join(tmpdir(), "pwrgit-commit-author-signature-"));
  dir = join(container, "migrations");
  mkdirSync(dir);
  for (const file of readdirSync(MIGRATIONS)) {
    if (file < UPGRADE) cpSync(join(MIGRATIONS, file), join(dir, file));
  }
  path = join(container, "app.db");
  db = openDatabase(path, dir);
  const insert = db.prepare(
    `INSERT INTO github_commit_author_identity_cache(
       identity_key, status, github_login, avatar_url, fetched_at, expires_at,
       last_accessed_at, failure_count, next_retry_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?)`
  );
  insert.run("linked", "resolved", "ada", FETCHED, FETCHED + WEEK, FETCHED, FETCHED);
  insert.run("no-account", "negative", null, FETCHED, FETCHED + WEEK, FETCHED, FETCHED);
  insert.run("failed", "unavailable", null, 0, 0, FETCHED, FETCHED);
  db.close();
  cpSync(join(MIGRATIONS, UPGRADE), join(dir, UPGRADE));
  db = openDatabase(path, dir);
});

afterEach(() => {
  db.close();
  rmSync(container, { recursive: true, force: true });
});

function row(key: string): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM github_commit_author_identity_cache WHERE identity_key = ?")
    .get(key) as Record<string, unknown>;
}

it("starts every existing row unverified, since none was ever asked", () => {
  for (const key of ["linked", "no-account", "failed"]) {
    expect(row(key).signature_verified).toBe(0);
  }
});

it("marks linked rows stale so they are re-asked, keeping the login that paints", () => {
  expect(row("linked")).toMatchObject({
    github_login: "ada",
    fetched_at: FETCHED,
    expires_at: FETCHED
  });
  // A "no account" answer has no signature to learn; its TTL is untouched.
  expect(row("no-account").expires_at).toBe(FETCHED + WEEK);
  expect(row("failed").expires_at).toBe(0);
});
