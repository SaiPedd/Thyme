import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, openDb } from "../src/db";
import { MIGRATIONS } from "../src/db/schema";

const TABLES = [
  "balance_entries", "claims", "expense_shares", "expenses", "households", "items", "ledger", "mealdb_by_ingredient",
  "mealdb_meals", "members", "nudges", "payments", "prefs", "seen_messages", "sends", "shelf_life", "shelf_life_fts", "state", "turns",
  "usage_counters",
];

function seedBasics(db: Database) {
  db.run("INSERT INTO households (id, name, tz, mode, created_at) VALUES (1, 'h', 'America/New_York', 'group', 't')");
  db.run("INSERT INTO members (id, household_id, phone, name, created_at) VALUES (1, 1, '+16095550101', 'A', 't')");
  db.run("INSERT INTO members (id, household_id, phone, name, created_at) VALUES (2, 1, '+16095550102', 'B', 't')");
  db.run("INSERT INTO items (id, household_id, name, storage, added_at) VALUES (1, 1, 'spinach', 'fridge', 't')");
}

describe("schema", () => {
  test("creates every table", () => {
    const db = openDb(":memory:");
    const names = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'shelf_life_fts_%' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(TABLES);
  });

  test("migrate is idempotent", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toBe(0);
  });

  test("repairs a database from the pre-merge phase-5 branch (ledger was migration 4 there)", () => {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS.slice(0, 3)) db.exec(m);
    db.exec(MIGRATIONS[4]!); // the ledger column, applied as "4" on the old branch
    db.exec("PRAGMA user_version = 4");
    seedBasics(db);
    migrate(db);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'mealdb_meals'").get()).toBeTruthy();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM items").get()!.n).toBe(1);
  });

  test("refuses an old-layout database instead of silently mixing schemas", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE events (id INTEGER)");
    expect(() => migrate(db)).toThrow(/older layout/);
  });

  test("only one claim can win per item", () => {
    const db = openDb(":memory:");
    seedBasics(db);
    db.run("INSERT INTO claims (item_id, member_id, claimed_at, won, created_at) VALUES (1, 1, 't1', 1, 't')");
    db.run("INSERT INTO claims (item_id, member_id, claimed_at, won, created_at) VALUES (1, 2, 't2', 0, 't')");
    expect(() =>
      db.run("INSERT INTO claims (item_id, member_id, claimed_at, won, created_at) VALUES (1, 2, 't3', 1, 't')"),
    ).toThrow();
  });

  test("nudges allow attempt 1 and 2 only, once each", () => {
    const db = openDb(":memory:");
    seedBasics(db);
    const ins = (attempt: number) =>
      db.run("INSERT INTO nudges (item_id, audience, attempt, sent_at) VALUES (1, 'group', ?, 't')", [attempt]);
    ins(1);
    ins(2);
    expect(() => ins(3)).toThrow();
    expect(() => ins(2)).toThrow();
  });

  test("duplicate expenses are rejected by dedupe_hash", () => {
    const db = openDb(":memory:");
    seedBasics(db);
    const ins = () =>
      db.run(
        "INSERT INTO expenses (household_id, buyer_member_id, total_cents, mode, source, dedupe_hash, created_at) VALUES (1, 1, 4860, 'equal', 'text', 'h1', 't')",
      );
    ins();
    expect(ins).toThrow();
  });

  test("a balance entry can't be owed to yourself", () => {
    const db = openDb(":memory:");
    seedBasics(db);
    expect(() =>
      db.run(
        "INSERT INTO balance_entries (household_id, debtor_member_id, creditor_member_id, amount_cents, source, source_id, created_at) VALUES (1, 1, 1, 100, 'expense', 1, 't')",
      ),
    ).toThrow();
  });

  test("a send targets exactly one of chat_id or to_phone", () => {
    const db = openDb(":memory:");
    const ins = (chat: string | null, to: string | null) =>
      db.run(
        "INSERT INTO sends (id, audience, chat_id, to_phone, kind, status, created_at) VALUES (?, 'group', ?, ?, 'reply', 'queued', 't')",
        [crypto.randomUUID(), chat, to],
      );
    ins("chat1", null);
    ins(null, "+16095550101");
    expect(() => ins("chat1", "+16095550101")).toThrow();
    expect(() => ins(null, null)).toThrow();
  });
});
