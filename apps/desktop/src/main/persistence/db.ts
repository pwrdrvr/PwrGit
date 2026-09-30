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
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file);
    })();
  }
}
