import { afterEach, describe, expect, test } from "bun:test";
import { advanceDays, resetClock } from "../src/clock";
import { openDb } from "../src/db";
import { balancesFor, DuplicateExpenseError, recordExpense, undoLastExpense } from "../src/domain/expenses";

afterEach(() => resetClock());

function setup() {
  const db = openDb(":memory:");
  db.run("INSERT INTO households (id, name, tz, mode, created_at) VALUES (1, 'h', 'America/New_York', 'group', 't')");
  for (const [id, name] of [[1, "A"], [2, "B"], [3, "C"]] as const) {
    db.run("INSERT INTO members (id, household_id, phone, name, created_at) VALUES (?, 1, ?, ?, 't')", [id, `+1609555010${id}`, name]);
  }
  return db;
}

const demo = { totalCents: 4860, buyerId: 1, memberIds: [1, 2, 3], allocations: [{ amountCents: 900, memberIds: [1] }] };

describe("expenses", () => {
  test("record: shares stored and balances computed", () => {
    const db = setup();
    const e = recordExpense(db, { householdId: 1, tz: "America/New_York", spec: demo });
    expect(e.shares.reduce((s, x) => s + x.cents, 0)).toBe(4860);
    expect(balancesFor(db, 1, 1)).toEqual({ netCents: 2640, lines: [{ otherMemberId: 2, netCents: 1320 }, { otherMemberId: 3, netCents: 1320 }] });
    expect(balancesFor(db, 1, 2)).toEqual({ netCents: -1320, lines: [{ otherMemberId: 1, netCents: -1320 }] });
  });

  test("duplicate detection by buyer, total, and date", () => {
    const db = setup();
    recordExpense(db, { householdId: 1, tz: "America/New_York", spec: demo });
    expect(() => recordExpense(db, { householdId: 1, tz: "America/New_York", spec: demo })).toThrow(DuplicateExpenseError);
    // Confirmed second purchase, or a new day, is fine.
    expect(() => recordExpense(db, { householdId: 1, tz: "America/New_York", spec: demo, allowDuplicate: true })).not.toThrow();
    advanceDays(1);
    expect(() => recordExpense(db, { householdId: 1, tz: "America/New_York", spec: demo })).not.toThrow();
  });

  test("undo reverses the last expense and its balances; re-logging works after undo", () => {
    const db = setup();
    recordExpense(db, { householdId: 1, tz: "America/New_York", spec: demo });
    expect(undoLastExpense(db, 1, 1)).toMatchObject({ totalCents: 4860 });
    expect(balancesFor(db, 1, 1)).toEqual({ netCents: 0, lines: [] });
    expect(undoLastExpense(db, 1, 1)).toBeNull();
    expect(() => recordExpense(db, { householdId: 1, tz: "America/New_York", spec: demo })).not.toThrow();
  });

  test("balances net out across expenses in both directions", () => {
    const db = setup();
    recordExpense(db, { householdId: 1, tz: "America/New_York", spec: { totalCents: 3000, buyerId: 1, memberIds: [1, 2, 3] } });
    recordExpense(db, { householdId: 1, tz: "America/New_York", spec: { totalCents: 1200, buyerId: 2, memberIds: [1, 2, 3] } });
    // A paid 3000 (B owes 1000); B paid 1200 (A owes 400) -> B owes A 600.
    expect(balancesFor(db, 1, 1).lines.find((l) => l.otherMemberId === 2)?.netCents).toBe(600);
  });
});
