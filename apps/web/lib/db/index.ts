import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations";

export type Db = Database.Database;

const globalForDb = globalThis as unknown as { __hubDb?: Db };

/** Open (or create) a hub database and bring its schema up to date. */
export function openDatabase(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => (r as { version: number }).version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        nowIso(),
      );
    })();
  }
}

/** Process-wide database at $HUB_DATA_DIR/hub.db (survives Next.js dev hot reloads). */
export function getDb(): Db {
  if (!globalForDb.__hubDb) {
    const dir = process.env.HUB_DATA_DIR ?? "./.data";
    globalForDb.__hubDb = openDatabase(path.join(dir, "hub.db"));
  }
  return globalForDb.__hubDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}
