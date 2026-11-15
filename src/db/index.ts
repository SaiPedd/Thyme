// Open the SQLite database and apply pending migrations.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema";

export const DEFAULT_DB_PATH = "data/fridge.db";

/** Apply migrations newer than PRAGMA user_version, each in its own transaction. */
export function migrate(db: Database): number {
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  if (current === 0 && db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) {
    throw new Error(
      "Database has tables from an older layout. It's local and rebuildable: delete data/fridge.db* and restart.",
    );
  }
  // Repair: before Phase 4 and 5 were merged, the phase-5 branch used migration 4 for the waste ledger
  // (now 5; 4 is the TheMealDB cache). A database from that branch is at version 4 with the ledger
  // column but no cache tables: add the cache tables and mark it as version 5.
  const has = (sql: string) => !!db.query(sql).get();
  if (
    current === 4 &&
    has("SELECT 1 FROM pragma_table_info('ledger') WHERE name = 'priced'") &&
    !has("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mealdb_meals'")
  ) {
    db.transaction(() => {
      db.exec(MIGRATIONS[3]!);
      db.exec("PRAGMA user_version = 5");
    })();
    return migrate(db) + 1;
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length - current;
}

/** Open (creating if needed) and migrate. Use ":memory:" in tests. */
export function openDb(path: string = process.env.DB_PATH || DEFAULT_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}
