// SQLite schema as numbered migrations (PRAGMA user_version tracks which ran).
// All times are ISO strings from now() (src/clock.ts). All money is integer cents.
// Privacy: items.owner_member_id NULL = shared with the household, otherwise personal.

export const MIGRATIONS: string[] = [
  // 1: initial Fridge Squad schema
  `
CREATE TABLE households (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  chat_id     TEXT UNIQUE,                                   -- Claw group chatId (group mode)
  tz          TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('group','dm')),
  created_at  TEXT NOT NULL
);

CREATE TABLE members (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id),
  phone         TEXT NOT NULL UNIQUE,                        -- +E.164
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- USDA FoodKeeper, shelf life normalized to whole days. NULL = not listed.
CREATE TABLE shelf_life (
  id                INTEGER PRIMARY KEY,                     -- FoodKeeper product ID
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
  pantry_note       TEXT,                                    -- e.g. "When Ripe"
  fridge_note       TEXT,                                    -- e.g. "Package use-by date"
  freezer_note      TEXT
);
CREATE VIRTUAL TABLE shelf_life_fts USING fts5(
  name, subtitle, keywords, content='shelf_life', content_rowid='id'
);

CREATE TABLE items (
  id               INTEGER PRIMARY KEY,
  household_id     INTEGER NOT NULL REFERENCES households(id),
  name             TEXT NOT NULL,
  shelf_life_id    INTEGER REFERENCES shelf_life(id),
  storage          TEXT NOT NULL CHECK (storage IN ('pantry','fridge','freezer')),
  owner_member_id  INTEGER REFERENCES members(id),          -- NULL = shared
  buyer_member_id  INTEGER REFERENCES members(id),
  qty              REAL,
  unit             TEXT,
  cost_cents       INTEGER,
  cost_source      TEXT CHECK (cost_source IN ('receipt','user','estimate')),
  added_at         TEXT NOT NULL,
  expires_at       TEXT,                                     -- computed in code, conservative low end
  status           TEXT NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh','used','tossed')),
  status_at        TEXT
);
CREATE INDEX items_expiring ON items(household_id, status, expires_at);

CREATE TABLE expenses (
  id                 INTEGER PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES households(id),
  buyer_member_id    INTEGER NOT NULL REFERENCES members(id),
  total_cents        INTEGER NOT NULL CHECK (total_cents > 0),
  mode               TEXT NOT NULL CHECK (mode IN ('equal','per_item','subset','custom')),
  description        TEXT,
  source             TEXT NOT NULL CHECK (source IN ('text','receipt')),
  dedupe_hash        TEXT NOT NULL UNIQUE,                   -- hash(buyer, total, date)
  source_message_id  TEXT,
  created_at         TEXT NOT NULL,
  undone_at          TEXT
);

CREATE TABLE expense_shares (
  id           INTEGER PRIMARY KEY,
  expense_id   INTEGER NOT NULL REFERENCES expenses(id),
  member_id    INTEGER NOT NULL REFERENCES members(id),
  share_cents  INTEGER NOT NULL CHECK (share_cents >= 0),
  UNIQUE (expense_id, member_id)
);

CREATE TABLE ledger (
  id               INTEGER PRIMARY KEY,
  household_id     INTEGER NOT NULL REFERENCES households(id),
  item_id          INTEGER REFERENCES items(id),
  member_id        INTEGER REFERENCES members(id),
  kind             TEXT NOT NULL CHECK (kind IN ('rescued','wasted')),
  cost_cents       INTEGER NOT NULL DEFAULT 0,
  shared           INTEGER NOT NULL CHECK (shared IN (0,1)),
  buyer_member_id  INTEGER REFERENCES members(id),
  at               TEXT NOT NULL
);

-- The one combined balance table: grocery splits and shared waste.
CREATE TABLE balance_entries (
  id                  INTEGER PRIMARY KEY,
  household_id        INTEGER NOT NULL REFERENCES households(id),
  debtor_member_id    INTEGER NOT NULL REFERENCES members(id),
  creditor_member_id  INTEGER NOT NULL REFERENCES members(id),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  source              TEXT NOT NULL CHECK (source IN ('expense','waste')),
  source_id           INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  undone_at           TEXT,
  CHECK (debtor_member_id <> creditor_member_id)
);
CREATE INDEX balance_by_member ON balance_entries(household_id, debtor_member_id, creditor_member_id);

CREATE TABLE claims (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  message_id  TEXT,
  claimed_at  TEXT NOT NULL,                                 -- inbound sentAt, else receive time
  won         INTEGER NOT NULL DEFAULT 0 CHECK (won IN (0,1)),
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX claims_one_winner ON claims(item_id) WHERE won = 1;

CREATE TABLE prefs (
  id          INTEGER PRIMARY KEY,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  kind        TEXT NOT NULL CHECK (kind IN ('diet','dislike','allergy','like')),
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (member_id, kind, value)
);

-- Expiry reminders: attempt 1, then at most one retry.
CREATE TABLE nudges (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  audience      TEXT NOT NULL CHECK (audience IN ('group','member')),
  member_id     INTEGER REFERENCES members(id),
  attempt       INTEGER NOT NULL CHECK (attempt IN (1,2)),
  send_id       TEXT,
  sent_at       TEXT NOT NULL,
  responded_at  TEXT,
  UNIQUE (item_id, attempt)
);

CREATE TABLE seen_messages (
  message_id   TEXT PRIMARY KEY,
  chat_id      TEXT,
  received_at  TEXT NOT NULL
);

-- Capped per-chat conversation history for the agent loop.
CREATE TABLE turns (
  id          INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  member_id   INTEGER REFERENCES members(id),
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX turns_by_chat ON turns(chat_id, id);

CREATE TABLE usage_counters (
  month      TEXT PRIMARY KEY,                               -- 'YYYY-MM'
  inbound    INTEGER NOT NULL DEFAULT 0,
  outbound   INTEGER NOT NULL DEFAULT 0,
  proactive  INTEGER NOT NULL DEFAULT 0
);

-- Outbox: one row per send, tracking Claw send.result and later status events.
CREATE TABLE sends (
  id          TEXT PRIMARY KEY,                              -- our client id, also the Claw "id"
  audience    TEXT NOT NULL CHECK (audience IN ('group','member')),
  chat_id     TEXT,
  to_phone    TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('reply','proactive')),
  status      TEXT NOT NULL CHECK (status IN ('queued','deferred','accepted','delivered','read','failed')),
  message_id  TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  not_before  TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  CHECK ((chat_id IS NULL) <> (to_phone IS NULL))
);
CREATE INDEX sends_due ON sends(status, not_before);

CREATE TABLE state (
  key    TEXT PRIMARY KEY,                                   -- e.g. 'last_seen_at'
  value  TEXT
);
`,
  // 2: outbox keeps the text of deferred sends (quiet hours) so they can go out later.
  // Stored in the database only; never logged.
  `
ALTER TABLE sends ADD COLUMN body TEXT;
ALTER TABLE sends ADD COLUMN reply_to TEXT;
`,
  // 3: members come from the group's participants; named = 0 until they tell us their name.
  `
ALTER TABLE members ADD COLUMN named INTEGER NOT NULL DEFAULT 1;
`,
  // 4: local cache of TheMealDB lookups (live API + cache; the DB file is gitignored, never committed).
  `
CREATE TABLE mealdb_meals (
  id          TEXT PRIMARY KEY,                              -- idMeal
  data        TEXT NOT NULL,                                 -- the meal JSON as returned
  fetched_at  TEXT NOT NULL
);
CREATE TABLE mealdb_by_ingredient (
  ingredient  TEXT PRIMARY KEY,                              -- normalized query, e.g. "chicken_thighs"
  meal_ids    TEXT NOT NULL,                                 -- JSON array of idMeal
  fetched_at  TEXT NOT NULL
);
`,
];
