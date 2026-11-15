// Phase 5: the waste ledger, shared waste in the combined balances, undo, and the group-safe summary.

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runTool, type ToolContext } from "../src/agent/tools";
import { parseIntent } from "../src/agent/fallback";
import { advance, advanceDays, now, resetClock, setNow } from "../src/clock";
import { balancesFor, recordExpense } from "../src/domain/expenses";
import { importFoodKeeperFile } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { impactFor } from "../src/domain/impact";
import { addItem } from "../src/domain/inventory";
import { wasteTotals } from "../src/domain/waste";
import { Inbox } from "../src/inbox";
import { Outbox } from "../src/outbox";
import { makeRouter } from "../src/router";
import { Scheduler } from "../src/scheduler";
import { FakeAdapter, PHONES, quietLog, setupHousehold } from "./helpers";

// 10:00 in New York.
const T0 = new Date("2026-11-14T15:00:00Z");

afterEach(() => resetClock());

async function household(): Promise<Database> {
  const db = setupHousehold();
  await importFoodKeeperFile(db);
  return db;
}

function ctxFor(db: Database, memberIndex = 0, isGroup = true): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup, messageId: crypto.randomUUID(), drafts: [] };
}

function add(db: Database, name: string, opts: { buyer?: number; owner?: number | null; cents?: number | null } = {}) {
  const r = addItem(db, { householdId: 1, name, buyerId: opts.buyer ?? 1, ownerId: opts.owner ?? null, state: "raw", priceCents: opts.cents });
  if (!r.ok) throw new Error(`couldn't add ${name}`);
  return r.item;
}

const net = (db: Database, memberId: number) => balancesFor(db, 1, memberId).netCents;
const wasteEntries = (db: Database) =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM balance_entries WHERE source = 'waste' AND undone_at IS NULL").get()!.n;

describe("shared toss", () => {
  test("splits equally into balances; shares sum to the cost and leftover cents go to the buyer", async () => {
    const db = await household();
    setNow(T0);
    add(db, "spinach", { cents: 401 });
    advanceDays(1);
    const r = runTool("log_toss", { item: "the spinach" }, ctxFor(db, 1));
    expect(r).toMatchObject({ done: true, cost: "$4.01", who_owes_whom: ["Sam owes Alex $1.33", "Jordan owes Alex $1.33"] });
    expect(net(db, 1)).toBe(266); // Alex paid; their own 135 share includes the leftover cent
    expect(net(db, 2)).toBe(-133);
    expect(net(db, 3)).toBe(-133);
    const ledger = db.query("SELECT kind, cost_cents, shared, member_id, buyer_member_id FROM ledger").all();
    expect(ledger).toEqual([{ kind: "wasted", cost_cents: 401, shared: 1, member_id: 2, buyer_member_id: 1 }]);
  });

  test("not split again when the buyer already logged an expense that day", async () => {
    const db = await household();
    setNow(T0);
    recordExpense(db, { householdId: 1, tz: "America/New_York", spec: { totalCents: 3000, buyerId: 1, memberIds: [1, 2, 3] } });
    add(db, "spinach", { cents: 400 });
    const before = net(db, 2);
    const r = runTool("log_toss", { item: "spinach" }, ctxFor(db, 0));
    expect(r).toMatchObject({ done: true, note: expect.stringContaining("already split") });
    expect(r.who_owes_whom).toBeUndefined();
    expect(net(db, 2)).toBe(before);
    expect(wasteEntries(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 1 });
  });

  test("unknown price: ledger row at $0, balances unchanged", async () => {
    const db = await household();
    setNow(T0);
    db.run("INSERT INTO items (household_id, name, storage, owner_member_id, buyer_member_id, qty, added_at, status) VALUES (1, 'mystery stew', 'fridge', NULL, 1, 1, ?, 'fresh')", [now().toISOString()]);
    expect(runTool("log_toss", { item: "mystery stew" }, ctxFor(db, 0))).toMatchObject({ done: true, cost: "unknown" });
    expect(wasteEntries(db)).toBe(0);
    expect(db.query("SELECT cost_cents FROM ledger").get()).toEqual({ cost_cents: 0 });
  });
});

describe("personal toss", () => {
  test("costs only the owner: no balance entries, and the group hears nothing about the item", async () => {
    const db = await household();
    setNow(T0);
    add(db, "chicken thighs", { buyer: 1, owner: 1, cents: 900 });
    const ctx = ctxFor(db, 0, true);
    const r = runTool("log_toss", { item: "chicken" }, ctx);
    expect(r).toMatchObject({ done: true, sent_privately: true });
    expect(JSON.stringify(r)).not.toContain("chicken");
    expect(ctx.drafts).toHaveLength(1);
    expect(ctx.drafts[0]).toMatchObject({ audience: { kind: "member", memberId: 1 }, sensitivity: "personal", subjectMemberId: 1 });
    expect(wasteEntries(db)).toBe(0);
    expect(db.query("SELECT kind, shared FROM ledger").get()).toEqual({ kind: "wasted", shared: 0 });
  });
});

describe("rescues", () => {
  test("eating an at-risk item logs a rescue; a past-date item is not a rescue", async () => {
    const db = await household();
    setNow(T0);
    add(db, "strawberries", { cents: 450 }); // 2 days: at risk
    add(db, "eggs", { cents: 449 }); // weeks away: not at risk
    const ctx = ctxFor(db, 0);
    expect(runTool("use_item", { item: "strawberries" }, ctx)).toMatchObject({ rescued: true });
    expect(runTool("use_item", { item: "eggs" }, ctx).rescued).toBeUndefined();
    add(db, "spinach", { cents: 399 });
    advanceDays(10); // spinach is past its date now
    expect(runTool("use_item", { item: "spinach" }, ctx).rescued).toBeUndefined();
    expect(db.query("SELECT kind, cost_cents FROM ledger").all()).toEqual([{ kind: "rescued", cost_cents: 450 }]);
  });
});

describe("undo", () => {
  test("undoing a toss restores the item and the balances", async () => {
    const db = await household();
    setNow(T0);
    add(db, "spinach", { cents: 300 });
    advanceDays(1);
    const sam = ctxFor(db, 1);
    runTool("log_toss", { item: "spinach" }, sam);
    expect(net(db, 2)).toBe(-100);
    expect(runTool("undo_last", {}, sam)).toMatchObject({ undone: true, kind: "toss", item: "spinach" });
    expect(net(db, 2)).toBe(0);
    expect(db.query("SELECT status FROM items").get()).toEqual({ status: "fresh" });
    expect(db.query("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 0 });
    expect(runTool("undo_last", {}, sam)).toMatchObject({ undone: false });
  });

  test("undo picks whichever is newer: the expense or the toss", async () => {
    const db = await household();
    setNow(T0);
    add(db, "spinach", { cents: 300 });
    advanceDays(1);
    const alex = ctxFor(db, 0);
    runTool("log_toss", { item: "spinach" }, alex);
    advance(60_000);
    runTool("record_expense", { total: "$30" }, alex);
    expect(runTool("undo_last", {}, alex)).toMatchObject({ undone: true, kind: "expense", total: "$30.00" });
    expect(runTool("undo_last", {}, alex)).toMatchObject({ undone: true, kind: "toss" });
  });
});

describe("combined balances", () => {
  test("expenses and shared waste net into one number", async () => {
    const db = await household();
    setNow(T0);
    add(db, "spinach", { buyer: 2, cents: 600 }); // Sam bought it
    advanceDays(1);
    runTool("record_expense", { total: "$30" }, ctxFor(db, 0)); // Alex paid: Sam owes Alex $10
    runTool("log_toss", { item: "spinach" }, ctxFor(db, 2)); // shared waste: Alex owes Sam $2
    const alex = balancesFor(db, 1, 1);
    expect(alex.lines.find((l) => l.otherMemberId === 2)?.netCents).toBe(1000 - 200);
    expect(runTool("get_balances", {}, ctxFor(db, 1, false))).toMatchObject({ net: "you owe $6.00" }); // Sam: owes Alex $8 net, Jordan owes Sam $2
  });
});

describe("waste summary", () => {
  test("the group sees household totals only; a DM adds the member's own numbers", async () => {
    const db = await household();
    setNow(T0);
    add(db, "spinach", { cents: 400 });
    add(db, "chicken thighs", { owner: 1, cents: 900 });
    add(db, "strawberries", { cents: 450 });
    advanceDays(1);
    runTool("log_toss", { item: "spinach" }, ctxFor(db, 1));
    runTool("log_toss", { item: "chicken" }, ctxFor(db, 0));
    runTool("use_item", { item: "strawberries" }, ctxFor(db, 2));

    const group = runTool("get_waste_summary", {}, ctxFor(db, 0, true));
    expect(group).toMatchObject({ household_this_month: { tossed: { items: 2, dollars: "$13.00" }, rescued: { items: 1, dollars: "$4.50" } } });
    expect(group.you_this_month).toBeUndefined();
    const text = JSON.stringify(group);
    for (const name of ["Alex", "Sam", "Jordan", "chicken", "spinach"]) expect(text).not.toContain(name);

    const dm = runTool("get_waste_summary", {}, ctxFor(db, 1, false));
    expect(dm).toMatchObject({ you_this_month: { tossed: { items: 1, dollars: "$4.00" }, rescued: { items: 0 } } });
  });

  test("weight and CO2 come from the category table, and the fallback understands waste questions", async () => {
    const db = await household();
    setNow(T0);
    add(db, "chicken thighs", { cents: 900 });
    advanceDays(1);
    runTool("log_toss", { item: "chicken" }, ctxFor(db, 0));
    const row = db.query<{ category: string }, []>("SELECT s.category FROM items i JOIN shelf_life s ON s.id = i.shelf_life_id").get()!;
    const t = wasteTotals(db, 1);
    expect(t.wasted.co2Grams).toBe(impactFor(row.category).co2Grams);
    expect(t.wasted.co2Grams).toBeGreaterThan(impactFor("Produce").co2Grams);
    expect(parseIntent("how much have we wasted?")).toEqual({ kind: "waste" });
    expect(parseIntent("waste report")).toEqual({ kind: "waste" });
  });
});

describe("3-day fake-clock scenario with waste", () => {
  test("add → reminder → toss in the group → the split posts to the group, balances stay in DMs", async () => {
    const db = await household();
    db.run("INSERT INTO state (key, value) VALUES ('intro:chat-1', 't')");
    const adapter = new FakeAdapter();
    const outbox = new Outbox(db, adapter, { sleep: async () => {}, log: quietLog });
    const router = makeRouter({ db, outbox, adapter, botName: "Thyme", model: "x", client: null, log: quietLog });
    const inbox = new Inbox(db, router, { debounceMs: 5 });
    await adapter.start({ onMessage: (m) => inbox.push(m) });
    const scheduler = new Scheduler(db, outbox, { log: quietLog });

    setNow(T0);
    add(db, "spinach", { cents: 399 }); // 3 days in the fridge
    expect((await scheduler.tick())?.groupItems ?? []).toEqual([]);
    advanceDays(1);
    expect((await scheduler.tick())?.groupItems).toHaveLength(1); // within 48h now: group reminder
    advanceDays(2);

    adapter.receive({ from: PHONES[2]!, text: "Thyme tossed the spinach", sentAt: now().toISOString() });
    await new Promise((r) => setTimeout(r, 30));
    await inbox.drain();
    const groupReply = adapter.sent.at(-1)!;
    expect(groupReply.destination).toEqual({ kind: "group", chatId: "chat-1" });
    expect(groupReply.text).toContain("Logged the spinach as tossed ($3.99)");
    expect(groupReply.text).toContain("Sam owes Alex $1.33");

    adapter.receive({ from: PHONES[1]!, text: "what do I owe?", sentAt: now().toISOString() });
    await new Promise((r) => setTimeout(r, 30));
    await inbox.drain();
    const groupTexts = adapter.sent.filter((s) => s.destination.kind === "group").map((s) => s.text);
    expect(groupTexts.at(-1)).toContain("privately");
    const dm = adapter.sent.filter((s) => s.destination.kind === "member" && s.destination.phone === PHONES[1]).at(-1)!;
    expect(dm.text).toContain("you owe $1.33");
  });
});
