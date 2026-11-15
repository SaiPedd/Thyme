import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { parseIntent } from "../src/agent/fallback";
import { runTool, type ToolContext } from "../src/agent/tools";
import { addDays, resetClock, setNow } from "../src/clock";
import { getShelfLife, importFoodKeeperFile, pickShelfLife } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { addItem, expiryPhrase, matchItem } from "../src/domain/inventory";
import { estimatePriceCents } from "../src/domain/prices";
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

  test("price: user's number wins, else an estimate, labeled", () => {
    const est = addItem(db, { householdId: 1, name: "bananas", buyerId: 1, ownerId: null });
    const user = addItem(db, { householdId: 1, name: "bananas", buyerId: 1, ownerId: null, priceCents: 250 });
    if (!est.ok || !user.ok) throw new Error("not added");
    expect([est.item.cost_cents, est.item.cost_source]).toEqual([estimatePriceCents("bananas"), "estimate"]);
    expect([user.item.cost_cents, user.item.cost_source]).toEqual([250, "user"]);
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

describe("fallback rules for food", () => {
  test("parses inventory questions, claims, and logs; ignores 'got it'", () => {
    expect(parseIntent("what's in the fridge?")).toEqual({ kind: "inventory" });
    expect(parseIntent("what's expiring")).toEqual({ kind: "inventory" });
    expect(parseIntent("mine!")).toEqual({ kind: "claim" });
    expect(parseIntent("I'll take it")).toEqual({ kind: "claim" });
    expect(parseIntent("I'll take the spinach")).toEqual({ kind: "claim", item: "spinach" });
    expect(parseIntent("dibs on the bananas")).toEqual({ kind: "claim", item: "bananas" });
    expect(parseIntent("got spinach and milk")).toEqual({ kind: "add", items: ["spinach", "milk"] });
    expect(parseIntent("got it")).toBeNull();
    expect(parseIntent("tossed the leftover rice")).toEqual({ kind: "toss", item: "leftover rice" });
  });
});
