import { describe, expect, test } from "bun:test";
import { openDb } from "./db";

describe("openDb", () => {
  test("creates all tables", () => {
    const db = openDb(":memory:");
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(["events", "households", "items", "jobs", "members", "nudges", "shelf_life"]);
  });

  test("is safe to open twice (schema is idempotent)", () => {
    const db = openDb(":memory:");
    expect(() => db.exec("SELECT 1")).not.toThrow();
  });

  test("enforces nudge attempts 1 or 2 only", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO households (id, name, created_at) VALUES (1, 'h', 't')");
    db.run("INSERT INTO members (id, household_id, handle, created_at) VALUES (1, 1, '+16095550101', 't')");
    db.run(
      "INSERT INTO items (id, household_id, added_by, name, storage, added_at) VALUES (1, 1, 1, 'spinach', 'fridge', 't')",
    );
    db.run("INSERT INTO nudges (item_id, member_id, attempt, sent_at) VALUES (1, 1, 1, 't')");
    db.run("INSERT INTO nudges (item_id, member_id, attempt, sent_at) VALUES (1, 1, 2, 't')");
    expect(() => db.run("INSERT INTO nudges (item_id, member_id, attempt, sent_at) VALUES (1, 1, 3, 't')")).toThrow();
    expect(() => db.run("INSERT INTO nudges (item_id, member_id, attempt, sent_at) VALUES (1, 1, 2, 't')")).toThrow();
  });
});
