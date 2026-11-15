// Settling up: "I paid Alex back $12", "Sam paid me back", "Alex and I are square".
// Balances go back to exactly $0, never past it; undo works; amounts stay out of the group.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseIntent, parsePayment, runFallback } from "../src/agent/fallback";
import { runTool, type ToolContext } from "../src/agent/tools";
import { addDays, resetClock, setNow } from "../src/clock";
import { migrate } from "../src/db";
import { MIGRATIONS } from "../src/db/schema";
import { balancesFor, recordExpense } from "../src/domain/expenses";
import { getHousehold, getMembers } from "../src/domain/household";
import { owedBetween, PaymentError, recordPayment } from "../src/domain/settle";
import { setupHousehold } from "./helpers";

const T0 = new Date("2026-11-14T15:00:00Z");
afterEach(() => resetClock());

// Alex (1) paid $30 for groceries split 3 ways: Sam (2) and Jordan (3) each owe Alex $10.
function withExpense() {
  setNow(T0);
  const db = setupHousehold();
  recordExpense(db, { householdId: 1, tz: "America/New_York", spec: { totalCents: 3000, buyerId: 1, memberIds: [1, 2, 3] } });
  setNow(addDays(T0, 0.01));
  return db;
}

function ctxFor(db: Database, memberId: number, isGroup = false): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members.find((m) => m.id === memberId)!, isGroup, messageId: crypto.randomUUID(), drafts: [] };
}

describe("payments in the balance table", () => {
  test("paying back exactly what's owed zeroes the balance", () => {
    const db = withExpense();
    expect(owedBetween(db, 1, 2, 1)).toBe(1000);
    const p = recordPayment(db, { householdId: 1, fromId: 2, toId: 1, amountCents: null, loggedById: 2 });
    expect(p).toMatchObject({ amountCents: 1000, stillOwedCents: 0 });
    expect(balancesFor(db, 1, 2).netCents).toBe(0);
    expect(balancesFor(db, 1, 1).netCents).toBe(1000); // Jordan still owes Alex
  });

  test("partial payments add up; overpaying or paying with nothing owed is refused", () => {
    const db = withExpense();
    recordPayment(db, { householdId: 1, fromId: 2, toId: 1, amountCents: 400, loggedById: 2 });
    expect(owedBetween(db, 1, 2, 1)).toBe(600);
    expect(() => recordPayment(db, { householdId: 1, fromId: 2, toId: 1, amountCents: 601, loggedById: 2 })).toThrow(PaymentError);
    recordPayment(db, { householdId: 1, fromId: 2, toId: 1, amountCents: 600, loggedById: 1 });
    expect(balancesFor(db, 1, 2).netCents).toBe(0);
    expect(() => recordPayment(db, { householdId: 1, fromId: 2, toId: 1, amountCents: null, loggedById: 2 })).toThrow("nothing is owed");
    // Alex doesn't owe Sam anything either way.
    expect(() => recordPayment(db, { householdId: 1, fromId: 1, toId: 2, amountCents: 100, loggedById: 1 })).toThrow(PaymentError);
  });

  test("migration 8 keeps existing balances and allows payments", () => {
    const db = new Database(":memory:", { strict: true });
    for (const sql of MIGRATIONS.slice(0, 7)) db.exec(sql);
    db.exec("PRAGMA user_version = 7");
    db.run("INSERT INTO households (id, name, tz, mode, created_at) VALUES (1, 'h', 'America/New_York', 'group', 't')");
    db.run("INSERT INTO members (id, household_id, phone, name, created_at) VALUES (1, 1, '+16095550101', 'A', 't'), (2, 1, '+16095550102', 'B', 't')");
    db.run("INSERT INTO balance_entries (household_id, debtor_member_id, creditor_member_id, amount_cents, source, source_id, created_at) VALUES (1, 2, 1, 500, 'expense', 1, 't')");
    expect(migrate(db)).toBe(MIGRATIONS.length - 7);
    expect(owedBetween(db, 1, 2, 1)).toBe(500);
    recordPayment(db, { householdId: 1, fromId: 2, toId: 1, amountCents: null, loggedById: 2 });
    expect(balancesFor(db, 1, 1).netCents).toBe(0);
  });
});

describe("understanding paybacks (rule-based)", () => {
  const names = ["Alex", "Sam", "Jordan"];
  test("phrasings", () => {
    expect(parsePayment("I paid Alex back $12", names)).toEqual({ kind: "payment", other: "alex", direction: "i_paid_them", amount: "12" });
    expect(parsePayment("venmo'd sam 20.50", names)).toEqual({ kind: "payment", other: "sam", direction: "i_paid_them", amount: "20.50" });
    expect(parsePayment("I paid Alex back", names)).toEqual({ kind: "payment", other: "alex", direction: "i_paid_them", amount: undefined });
    expect(parsePayment("Sam paid me back!", names)).toEqual({ kind: "payment", other: "sam", direction: "they_paid_me", amount: undefined });
    expect(parsePayment("jordan sent me $5", names)).toEqual({ kind: "payment", other: "jordan", direction: "they_paid_me", amount: "5" });
    for (const t of ["Alex and I are square", "me and alex are even", "we're settled up with Alex", "settle up with alex"]) {
      expect(parsePayment(t, names)).toMatchObject({ other: "alex", direction: "square" });
    }
  });

  test("not paybacks: expenses and other uses of 'paid'/'sent' stay what they were", () => {
    expect(parseIntent("I paid $48 for groceries", "", names)?.kind).toBe("expense");
    expect(parseIntent("paid for groceries $30 split 3 ways", "", names)?.kind).toBe("expense");
    expect(parseIntent("I paid rent $500", "", names)?.kind).not.toBe("payment");
    expect(parsePayment("I sent Sam the link", names)).toBeNull();
    expect(parsePayment("I paid Taylor back $5", names)).toBeNull(); // not a roommate
  });
});

describe("record_payment tool and undo", () => {
  test("in a DM: Sam says he paid Alex back; Sam sees the result, Alex gets a DM", async () => {
    const db = withExpense();
    const ctx = ctxFor(db, 2);
    const reply = await runFallback("I paid Alex back", ctx);
    expect(reply).toContain("Recorded: Sam paid Alex $10.00. Sam and Alex are now square.");
    expect(ctx.drafts.map((d) => d.audience)).toEqual([{ kind: "member", memberId: 1 }]);
    expect(ctx.drafts[0]!.text).toContain("logged by Sam");
  });

  test("'Alex and I are square' works out who paid; 'undo' removes the payment, not the expense", async () => {
    const db = withExpense();
    const ctx = ctxFor(db, 1);
    expect(await runFallback("Jordan and I are square", ctx)).toContain("Jordan paid Alex $10.00");
    expect(balancesFor(db, 1, 3).netCents).toBe(0);
    setNow(addDays(T0, 0.02));
    expect(await runFallback("undo", ctxFor(db, 1))).toContain("Undone: the $10.00 payment from Jordan to Alex is removed");
    expect(owedBetween(db, 1, 3, 1)).toBe(1000);
    // Next undo is the expense itself.
    expect(await runFallback("undo", ctxFor(db, 1))).toContain("$30.00 expense is removed");
  });

  test("too much, nothing owed, already square: clear answers, nothing saved", async () => {
    const db = withExpense();
    expect(await runFallback("I paid Alex back $15", ctxFor(db, 2))).toContain("Sam only owes Alex $10.00. Did you mean that?");
    expect(await runFallback("Sam paid me back", ctxFor(db, 3))).toContain("Sam doesn't owe Jordan anything");
    expect(await runFallback("Sam and I are square", ctxFor(db, 3))).toContain("already square");
    expect(db.query("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
  });

  test("in the group: no amounts in the group reply, both people get a DM", async () => {
    const db = withExpense();
    const ctx = ctxFor(db, 2, true);
    const reply = await runFallback("paid Alex back $10", ctx);
    expect(reply).toBe("Got it, recorded. I DM'd you both the details.");
    expect(reply).not.toMatch(/\$/);
    expect(ctx.drafts.map((d) => d.audience)).toEqual([
      { kind: "member", memberId: 2 },
      { kind: "member", memberId: 1 },
    ]);
    expect(ctx.drafts.every((d) => d.sensitivity === "personal" && d.subjectMemberId === (d.audience as { memberId: number }).memberId)).toBe(true);
    // A refusal in the group is private too.
    const ctx2 = ctxFor(db, 2, true);
    expect(await runFallback("I paid Alex back $5", ctx2)).toBe("I sent you the details privately.");
    expect(ctx2.drafts[0]!.text).toContain("doesn't owe");
  });

  test("the tool rejects unknown people and paying yourself", () => {
    const db = withExpense();
    expect(runTool("record_payment", { other: "Taylor", direction: "i_paid_them" }, ctxFor(db, 2))).toMatchObject({ recorded: false });
    expect(runTool("record_payment", { other: "me", direction: "i_paid_them" }, ctxFor(db, 2))).toMatchObject({ recorded: false });
  });
});
