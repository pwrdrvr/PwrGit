import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getNativeBinding } from "./native-binding";

export type DB = Database.Database;

// Migrations live next to this module as reviewable .sql files. In dev/test
// they resolve under src/; in a packaged build the electron.vite copy plugin
// places them beside the compiled main bundle. `import.meta.url` resolves both.
const DEFAULT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

/**
 * Open (or create) the SQLite database, apply pending migrations, and return
 * the connection. Pure with respect to Electron — the caller supplies the
 * path — so it is exercised directly in node unit tests.
 */
export function openDatabase(
  dbPath: string,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): DB {
  const db = new Database(dbPath, { nativeBinding: getNativeBinding() });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, migrationsDir);
  return db;
}

/**
 * Migrations renumbered after a database may already have run them, keyed by
 * the current name. A migration is recorded by file name, so a database that
 * applied the old name would otherwise run it again under the new one — and
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the duplicate column throws and
 * the database never opens. The old name in `schema_migrations` is the
 * evidence it already ran: record the new name and skip the SQL.
 */
const RENAMED_MIGRATIONS: Readonly<Record<string, readonly string[]>> = {
  // Built on a branch as 0036, which main then shipped as 0036_pinned_branches.
  "0038_worktree_fork_source.sql": ["0036_worktree_fork_source.sql"]
};

function runMigrations(db: DB, migrationsDir: string): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`
  );

  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as {
      name: string;
    }[]).map((r) => r.name)
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const record = db.prepare("INSERT INTO schema_migrations (name) VALUES (?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    if (RENAMED_MIGRATIONS[file]?.some((old) => applied.has(old)) === true) {
      record.run(file);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file);
    })();
  }
}
