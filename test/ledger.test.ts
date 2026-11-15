import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { describeToolResult, parseIntent, runFallback } from "../src/agent/fallback";
import { runTool, type ToolContext } from "../src/agent/tools";
import { addDays, resetClock, setNow } from "../src/clock";
import { balancesFor } from "../src/domain/expenses";
import { importFoodKeeperFile } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { wasteSummary } from "../src/domain/ledger";
import { setupHousehold } from "./helpers";

// 10:00 in New York.
const T0 = new Date("2026-11-14T15:00:00Z");

async function kitchen(): Promise<Database> {
  const db = setupHousehold();
  await importFoodKeeperFile(db);
  setNow(T0);
  return db;
}

function ctxFor(db: Database, memberIndex = 0, isGroup = true): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup, messageId: crypto.randomUUID(), drafts: [] };
}

const ledgerRows = (db: Database) =>
  db.query<{ kind: string; cost_cents: number; priced: number; shared: number; member_id: number | null }, []>(
    "SELECT kind, cost_cents, priced, shared, member_id FROM ledger ORDER BY id",
  ).all();

afterEach(() => resetClock());

describe("waste ledger", () => {
  test("tossing a priced shared item writes one wasted row with its cost", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db, 1);
    runTool("add_item", { items: [{ name: "spinach", state: "raw", price: "$4" }] }, ctx);
    const r = runTool("log_toss", { item: "spinach" }, ctx);
    expect(r).toMatchObject({ done: true, status: "tossed", wasted_cost: "$4.00" });
    expect(ledgerRows(db)).toEqual([{ kind: "wasted", cost_cents: 400, priced: 1, shared: 1, member_id: 2 }]);
  });

  test("an unpriced toss is counted as unpriced, never estimated", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "yogurt" }] }, ctx);
    const r = runTool("log_toss", { item: "yogurt" }, ctx);
    expect(r).not.toHaveProperty("wasted_cost");
    expect(ledgerRows(db)).toEqual([{ kind: "wasted", cost_cents: 0, priced: 0, shared: 1, member_id: 1 }]);
    expect(wasteSummary(db, 1).wasted).toEqual({ count: 1, cents: 0, unpriced: 1 });
  });

  test("eating an at-risk item is a rescue; eating a fresh one isn't logged", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "strawberries", state: "raw", price: "$4.49" }, { name: "eggs", state: "raw" }] }, ctx);
    expect(runTool("use_item", { item: "strawberries" }, ctx)).toMatchObject({ done: true, rescued: true });
    expect(runTool("use_item", { item: "eggs" }, ctx)).toMatchObject({ done: true });
    expect(ledgerRows(db)).toEqual([{ kind: "rescued", cost_cents: 449, priced: 1, shared: 1, member_id: 1 }]);
  });

  test("a toss never changes anyone's balance", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("record_expense", { total: "$30" }, ctx);
    const before = [1, 2, 3].map((id) => balancesFor(db, 1, id));
    runTool("add_item", { items: [{ name: "spinach", state: "raw", price: "$4" }] }, ctx);
    runTool("log_toss", { item: "spinach" }, ctxFor(db, 2));
    expect([1, 2, 3].map((id) => balancesFor(db, 1, id))).toEqual(before);
  });

  test("this week vs all time", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "spinach", state: "raw", price: "$4" }] }, ctx);
    runTool("log_toss", { item: "spinach" }, ctx);
    setNow(addDays(T0, 10));
    runTool("add_item", { items: [{ name: "yogurt", price: "$1.29" }] }, ctxFor(db));
    runTool("log_toss", { item: "yogurt" }, ctxFor(db));
    expect(wasteSummary(db, 1, { sinceDays: 7 }).wasted).toEqual({ count: 1, cents: 129, unpriced: 0 });
    expect(wasteSummary(db, 1).wasted).toEqual({ count: 2, cents: 529, unpriced: 0 });
  });
});

describe("waste summary privacy", () => {
  async function withTosses() {
    const db = await kitchen();
    runTool("add_item", { items: [{ name: "spinach", state: "raw", price: "$4" }] }, ctxFor(db, 0, false));
    runTool("add_item", { items: [{ name: "chicken thighs", state: "raw", owner: "me", price: "$9" }] }, ctxFor(db, 0, false));
    runTool("log_toss", { item: "spinach" }, ctxFor(db, 1, false));
    runTool("log_toss", { item: "chicken thighs" }, ctxFor(db, 0, false));
    return db;
  }

  test("the group sees household totals only: no items, no names", async () => {
    const db = await withTosses();
    const r = runTool("get_waste_summary", {}, ctxFor(db, 1, true));
    const text = JSON.stringify(r) + describeToolResult("get_waste_summary", r);
    for (const secret of ["spinach", "chicken", "Alex", "Sam", "Jordan"]) expect(text).not.toContain(secret);
    expect(r).not.toHaveProperty("yours");
    expect((r as any).household.all_time.wasted).toEqual({ items: 2, known_cost: "$13.00" });
  });

  test("a DM adds the sender's own items", async () => {
    const db = await withTosses();
    const alex = runTool("get_waste_summary", {}, ctxFor(db, 0, false)) as any;
    expect(alex.yours.all_time.wasted).toEqual({ items: 1, known_cost: "$9.00" });
    const sam = runTool("get_waste_summary", {}, ctxFor(db, 1, false)) as any;
    expect(sam.yours.all_time.wasted).toEqual({ items: 0, known_cost: "$0.00" });
  });

  test("a personal item tossed in the group: done, but named (with its cost) only in the owner's DM", async () => {
    const db = await kitchen();
    runTool("add_item", { items: [{ name: "chicken thighs", state: "raw", owner: "me", price: "$9" }] }, ctxFor(db, 0, false));
    const ctx = ctxFor(db, 0, true);
    const r = runTool("log_toss", { item: "chicken thighs" }, ctx);
    expect(r).toMatchObject({ done: true, personal_logged_privately: true });
    expect(JSON.stringify(r)).not.toContain("chicken");
    expect(JSON.stringify(r)).not.toContain("$9");
    expect(describeToolResult("log_toss", r)).toBe("Done, I DM'd you the details.");
    expect(ctx.drafts).toHaveLength(1);
    expect(ctx.drafts[0]).toMatchObject({ audience: { kind: "member", memberId: 1 }, sensitivity: "personal", subjectMemberId: 1 });
    expect(ctx.drafts[0]!.text).toBe("Marked the chicken thighs as tossed ($9.00 of food wasted).");
    expect(ledgerRows(db)).toEqual([{ kind: "wasted", cost_cents: 900, priced: 1, shared: 0, member_id: 1 }]);

    // Saying it again in the group doesn't name it either.
    runTool("add_item", { items: [{ name: "chicken thighs", state: "raw", owner: "me" }] }, ctxFor(db, 0, false));
    const again = runTool("log_toss", { item: "chicken thighs" }, ctxFor(db, 0, true));
    expect(again).toMatchObject({ done: false, already_done: true });
    expect(JSON.stringify(again)).not.toContain("chicken");
  });

  test("the 'already tossed' check never names someone else's personal item", async () => {
    const db = await kitchen();
    // Alex tosses their own chicken in a DM.
    runTool("add_item", { items: [{ name: "chicken thighs", state: "raw", owner: "me" }] }, ctxFor(db, 0, false));
    runTool("log_toss", { item: "chicken thighs" }, ctxFor(db, 0, false));
    // Sam then tosses the shared chicken: it's done, and Alex's chicken isn't mentioned.
    runTool("add_item", { items: [{ name: "chicken", state: "raw" }] }, ctxFor(db, 1, false));
    const r = runTool("log_toss", { item: "chicken" }, ctxFor(db, 1, false));
    expect(r).toMatchObject({ done: true, item: "chicken" });
    expect(JSON.stringify(r)).not.toContain("thighs");
  });

  test("using a personal item in the group is confirmed by DM", async () => {
    const db = await kitchen();
    runTool("add_item", { items: [{ name: "greek yogurt", owner: "me" }] }, ctxFor(db, 1, false));
    const ctx = ctxFor(db, 1, true);
    const r = runTool("use_item", { item: "yogurt" }, ctx);
    expect(r).toMatchObject({ done: true, personal_logged_privately: true });
    expect(JSON.stringify(r)).not.toContain("yogurt");
    expect(ctx.drafts[0]!.text).toContain("greek yogurt");
  });
});

describe("fallback rules for waste", () => {
  test("parses waste questions", () => {
    expect(parseIntent("how much have we wasted?")).toEqual({ kind: "waste" });
    expect(parseIntent("how much food did we throw out")).toEqual({ kind: "waste" });
    expect(parseIntent("waste report")).toEqual({ kind: "waste" });
    expect(parseIntent("tossed the milk")).toEqual({ kind: "toss", item: "milk" });
  });

  test("the fallback reply states totals and unpriced items", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "spinach", state: "raw", price: "$4" }, { name: "yogurt" }] }, ctx);
    expect(await runFallback("tossed the spinach", ctx)).toBe("Marked the spinach as tossed ($4.00 of food wasted).");
    await runFallback("tossed the yogurt", ctx);
    expect(await runFallback("how much have we wasted?", ctx)).toContain("wasted 2 items ($4.00, plus 1 with no price)");
  });
});
