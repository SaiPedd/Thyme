import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { parseIntent, runFallback } from "../src/agent/fallback";
import { runTool, type ToolContext } from "../src/agent/tools";
import { addDays, resetClock, setNow } from "../src/clock";
import { getShelfLife, importFoodKeeperFile, pickShelfLife } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { addItem, expiryPhrase, matchItem } from "../src/domain/inventory";
import { setupHousehold } from "./helpers";

// 10:00 in New York.
const T0 = new Date("2026-11-14T15:00:00Z");

async function withFoodKeeper(): Promise<Database> {
  const db = setupHousehold();
  await importFoodKeeperFile(db);
  return db;
}

function ctxFor(db: Database, memberIndex = 0, isGroup = true): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup, messageId: crypto.randomUUID(), drafts: [] };
}

afterEach(() => resetClock());

describe("conservative expiry from FoodKeeper", () => {
  let db: Database;
  beforeAll(async () => {
    db = await withFoodKeeper();
  });

  test("expires_at = added + the low end of the fridge range", () => {
    setNow(T0);
    const r = addItem(db, { householdId: 1, name: "spinach", buyerId: 1, ownerId: null, state: "raw" });
    if (!r.ok) throw new Error("not added");
    const row = getShelfLife(db, r.item.shelf_life_id!)!;
    expect(r.item.storage).toBe("fridge");
    expect(row.fridge_min_days!).toBeLessThanOrEqual(row.fridge_max_days!);
    expect(r.item.expires_at).toBe(addDays(new Date(r.item.added_at), row.fridge_min_days!).toISOString());
  });

  test("every FoodKeeper row with a range: min <= max, and expiry uses min", () => {
    const rows = db.query<{ id: number; fridge_min_days: number; fridge_max_days: number }, []>(
      "SELECT id, fridge_min_days, fridge_max_days FROM shelf_life WHERE fridge_min_days IS NOT NULL",
    ).all();
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) expect(r.fridge_min_days).toBeLessThanOrEqual(r.fridge_max_days);
  });

  test("raw vs cooked: asks when ambiguous, follows the phrase or state otherwise", () => {
    const rice = pickShelfLife(db, "rice");
    expect(rice && "ambiguous" in rice).toBe(true);
    const raw = pickShelfLife(db, "rice", "raw");
    expect(raw && "row" in raw && !/cooked/i.test(raw.row.name)).toBe(true);
    const leftover = pickShelfLife(db, "leftover rice");
    expect(leftover && "row" in leftover && /leftover/i.test(leftover.row.name)).toBe(true);
  });

  test("skips entries with no data; no number means no date, with the USDA note", () => {
    const r = addItem(db, { householdId: 1, name: "milk", buyerId: 1, ownerId: null, state: "raw" });
    if (!r.ok) throw new Error("not added");
    expect(r.item.expires_at).toBeNull();
    expect(r.note).toBe("Package use-by date");
    expect(expiryPhrase(r.item, "America/New_York", r.note)).toContain("package use-by date");
  });

  test("head noun wins over a modifier: baby spinach is spinach, not baby carrots", () => {
    const r = pickShelfLife(db, "baby spinach", "raw");
    expect(r && "row" in r && /spinach/i.test(`${r.row.name} ${r.row.subtitle}`)).toBe(true);
  });

  test("unknown things aren't added", () => {
    expect(addItem(db, { householdId: 1, name: "paper towels", buyerId: 1, ownerId: null })).toEqual({ ok: false, reason: "no_match" });
  });

  test("price: only what the person said they paid; never estimated", () => {
    const none = addItem(db, { householdId: 1, name: "bananas", buyerId: 1, ownerId: null });
    const user = addItem(db, { householdId: 1, name: "bananas", buyerId: 1, ownerId: null, priceCents: 250 });
    if (!none.ok || !user.ok) throw new Error("not added");
    expect([none.item.cost_cents, none.item.cost_source]).toEqual([null, null]);
    expect([user.item.cost_cents, user.item.cost_source]).toEqual([250, "user"]);
  });

  test("an expense line item prices the matching fridge item", async () => {
    const db2 = await withFoodKeeper();
    setNow(T0);
    const ctx = ctxFor(db2, 0, true);
    runTool("add_item", { items: [{ name: "chicken thighs", state: "raw" }, { name: "spinach", state: "raw" }] }, ctx);
    const r = runTool("record_expense", { total: "$30", items: [{ description: "chicken thighs", amount: "$9", members: ["me"] }] }, ctx);
    expect(r).toMatchObject({ recorded: true, item_prices_set: ["chicken thighs"] });
    const rows = db2.query<{ name: string; cost_cents: number | null; cost_source: string | null }, []>(
      "SELECT name, cost_cents, cost_source FROM items ORDER BY id",
    ).all();
    expect(rows).toEqual([
      { name: "chicken thighs", cost_cents: 900, cost_source: "user" },
      { name: "spinach", cost_cents: null, cost_source: null },
    ]);
  });
});

describe("expiry wording", () => {
  const tz = "America/New_York";
  test("today, tomorrow, N days, past", () => {
    setNow(T0);
    const at = (d: number) => ({ expires_at: addDays(T0, d).toISOString() });
    expect(expiryPhrase(at(0.3), tz)).toBe("expires today");
    expect(expiryPhrase(at(1), tz)).toBe("expires tomorrow");
    expect(expiryPhrase(at(4), tz)).toBe("expires in 4 days");
    expect(expiryPhrase(at(-0.1), tz)).toBe("past its USDA date");
  });
});

describe("matching items by name", () => {
  const items = [{ name: "baby spinach" }, { name: "bananas" }, { name: "chicken thighs" }];
  test("articles, plurals, and partial names", () => {
    expect(matchItem(items, "the spinach")?.name).toBe("baby spinach");
    expect(matchItem(items, "banana")?.name).toBe("bananas");
    expect(matchItem(items, "the last of the chicken")?.name).toBe("chicken thighs");
    expect(matchItem(items, "milk")).toBeNull();
  });
});

describe("inventory tools and privacy", () => {
  test("the group sees shared items only; a DM also shows the sender's own", async () => {
    const db = await withFoodKeeper();
    setNow(T0);
    runTool("add_item", { items: [{ name: "spinach", state: "raw" }] }, ctxFor(db, 0, false));
    runTool("add_item", { items: [{ name: "chicken thighs", state: "raw", owner: "me" }] }, ctxFor(db, 0, false));

    const group = runTool("get_inventory", {}, ctxFor(db, 0, true));
    expect(JSON.stringify(group)).toContain("spinach");
    expect(JSON.stringify(group)).not.toContain("chicken");

    const dm = runTool("get_inventory", {}, ctxFor(db, 0, false)) as any;
    expect(dm.yours.map((x: any) => x.item)).toEqual(["chicken thighs"]);
    // Someone else's DM doesn't see Alex's chicken.
    expect(JSON.stringify(runTool("get_inventory", {}, ctxFor(db, 1, false)))).not.toContain("chicken");
  });

  test("a personal item logged in the group is confirmed by DM, not named in the result", async () => {
    const db = await withFoodKeeper();
    const ctx = ctxFor(db, 0, true);
    const r = runTool("add_item", { items: [{ name: "chicken thighs", state: "raw", owner: "me" }] }, ctx);
    expect(JSON.stringify(r)).not.toContain("chicken");
    expect(ctx.drafts).toHaveLength(1);
    expect(ctx.drafts[0]).toMatchObject({ audience: { kind: "member", memberId: 1 }, sensitivity: "personal" });
    expect(ctx.drafts[0]!.text).toContain("chicken thighs");
  });

  test("use and toss change status; using an at-risk item is a rescue", async () => {
    const db = await withFoodKeeper();
    setNow(T0);
    const ctx = ctxFor(db, 0, true);
    runTool("add_item", { items: [{ name: "strawberries", state: "raw" }, { name: "yogurt" }] }, ctx);
    expect(runTool("use_item", { item: "the strawberries" }, ctx)).toMatchObject({ done: true, rescued: true });
    expect(runTool("log_toss", { item: "yogurt" }, ctx)).toMatchObject({ done: true, status: "tossed" });
    expect(runTool("use_item", { item: "yogurt" }, ctx)).toMatchObject({ done: false });
    const statuses = db.query<{ name: string; status: string }, []>("SELECT name, status FROM items ORDER BY id").all();
    expect(statuses).toEqual([
      { name: "strawberries", status: "used" },
      { name: "yogurt", status: "tossed" },
    ]);
  });
});

describe("buy, then ask what's there", () => {
  test("'I bought ...' then 'what is in my fridge?' lists it with where it's kept", async () => {
    const db = await withFoodKeeper();
    setNow(T0);
    const ctx = ctxFor(db, 0, true);
    runFallback("I bought spinach and rice", ctx);
    const reply = runFallback("what is in my fridge?", ctx)!;
    expect(reply).toContain("- spinach (fridge): expires in");
    expect(reply).toContain("- rice (pantry):");
  });

  test("'i just bought ...' is a food log (it was silently ignored before)", () => {
    expect(parseIntent("i just bought strawberries, bell peppers and greek yogurt")).toEqual({
      kind: "add",
      items: [{ name: "strawberries" }, { name: "bell peppers" }, { name: "greek yogurt" }],
    });
    expect(parseIntent("i threw the chicken thighs")).toEqual({ kind: "toss", item: "chicken thighs" });
    expect(parseIntent("we just tossed the milk")).toEqual({ kind: "toss", item: "milk" });
    expect(parseIntent("threw a party last night")).toBeNull();
  });

  test("tossing the same food twice doesn't toss a second, different item", async () => {
    const db = await withFoodKeeper();
    setNow(T0);
    const ctx = ctxFor(db, 0, true);
    runTool("add_item", { items: [{ name: "baby spinach", state: "raw" }, { name: "spinach", state: "raw" }] }, ctx);
    expect(runTool("log_toss", { item: "spinach" }, ctx)).toMatchObject({ done: true, item: "spinach" });
    // "no like i threw it out" -> the model calls log_toss("spinach") again.
    expect(runTool("log_toss", { item: "spinach" }, ctx)).toMatchObject({ done: false, already: "spinach" });
    // Naming the other one still works.
    expect(runTool("log_toss", { item: "baby spinach" }, ctx)).toMatchObject({ done: true, item: "baby spinach" });
    // And after a while, "tossed the spinach" means the next one again.
    runTool("add_item", { items: [{ name: "spinach", state: "raw" }] }, ctx);
    setNow(addDays(T0, 1));
    expect(runTool("log_toss", { item: "spinach" }, ctx)).toMatchObject({ done: true });
  });
});

describe("fallback rules for food", () => {
  test("parses inventory questions, claims, and logs; ignores 'got it'", () => {
    expect(parseIntent("what's in the fridge?")).toEqual({ kind: "inventory" });
    expect(parseIntent("what's expiring")).toEqual({ kind: "inventory" });
    for (const q of ["what is in my fridge?", "whats in my pantry", "what do I have", "what food do we have?", "show me the fridge", "what's left"]) {
      expect(parseIntent(q)).toEqual({ kind: "inventory" });
    }
    expect(parseIntent("mine!")).toEqual({ kind: "claim" });
    expect(parseIntent("I'll take it")).toEqual({ kind: "claim" });
    expect(parseIntent("I'll take the spinach")).toEqual({ kind: "claim", item: "spinach" });
    expect(parseIntent("dibs on the bananas")).toEqual({ kind: "claim", item: "bananas" });
    expect(parseIntent("got spinach and milk")).toEqual({ kind: "add", items: [{ name: "spinach" }, { name: "milk" }] });
    expect(parseIntent("got spinach for $4")).toEqual({ kind: "add", items: [{ name: "spinach", price: "$4" }] });
    expect(parseIntent("got eggs ($4.49) and milk")).toEqual({ kind: "add", items: [{ name: "eggs", price: "$4.49" }, { name: "milk" }] });
    expect(parseIntent("bought bananas $1.79.")).toEqual({ kind: "add", items: [{ name: "bananas", price: "$1.79" }] });
    expect(parseIntent("got it")).toBeNull();
    expect(parseIntent("tossed the leftover rice")).toEqual({ kind: "toss", item: "leftover rice" });
  });
});
