// SQLite schema (bun:sqlite). Times are ISO strings produced from now() in src/clock.ts.
// Privacy: items.owner_member_id NULL = shared with the household, otherwise personal.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB_PATH = "data/fridge.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS households (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id),
  handle        TEXT NOT NULL UNIQUE,          -- normalized phone (+E.164) or email
  name          TEXT,
  created_at    TEXT NOT NULL
);

-- One row per USDA FoodKeeper product. Shelf life normalized to whole days; NULL = not listed.
CREATE TABLE IF NOT EXISTS shelf_life (
  id                INTEGER PRIMARY KEY,       -- FoodKeeper product ID
  category          TEXT,
  name              TEXT NOT NULL,
  subtitle          TEXT,
  keywords          TEXT,
  pantry_min_days   INTEGER,
  pantry_max_days   INTEGER,
  fridge_min_days   INTEGER,
  fridge_max_days   INTEGER,
  freezer_min_days  INTEGER,
  freezer_max_days  INTEGER,
  -- USDA guidance with no number, e.g. "Package use-by date", "When Ripe", "Not Recommended".
  pantry_note       TEXT,
  fridge_note       TEXT,
  freezer_note      TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY,
  household_id     INTEGER NOT NULL REFERENCES households(id),
  owner_member_id  INTEGER REFERENCES members(id),   -- NULL = shared
  added_by         INTEGER NOT NULL REFERENCES members(id),
  name             TEXT NOT NULL,                    -- what the person said ("spinach")
  shelf_life_id    INTEGER REFERENCES shelf_life(id),
  storage          TEXT NOT NULL CHECK (storage IN ('pantry','fridge','freezer')),
  added_at         TEXT NOT NULL,
  expires_at       TEXT,                             -- computed in code from shelf_life
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','tossed')),
  cost_cents       INTEGER,
  weight_grams     INTEGER
);
CREATE INDEX IF NOT EXISTS items_active_expiry ON items(status, expires_at);

-- Append-only history (add, use, toss, nudge_sent, reply, ...). Feeds the waste ledger.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  item_id    INTEGER REFERENCES items(id),
  member_id  INTEGER REFERENCES members(id),
  kind       TEXT NOT NULL,
  at         TEXT NOT NULL,
  details    TEXT                                   -- JSON
);

-- Spoilage nudges: attempt 1, then at most one retry (attempt 2) with a different recipe.
CREATE TABLE IF NOT EXISTS nudges (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  attempt     INTEGER NOT NULL CHECK (attempt IN (1, 2)),
  recipe      TEXT,                                 -- JSON
  sent_at     TEXT NOT NULL,
  replied_at  TEXT,
  UNIQUE (item_id, member_id, attempt)
);

-- Scheduled work, polled each minute using now().
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  run_at      TEXT NOT NULL,
  payload     TEXT,                                 -- JSON
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
`;

/** Open (and create if needed) the database, apply the schema. Use ":memory:" in tests. */
export function openDb(path: string = process.env.DB_PATH || DEFAULT_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
