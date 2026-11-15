// Giving food away: places come only from data/donation-sites.json, and code decides what can go where.

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { describeToolResult, parseIntent, runFallback } from "../src/agent/fallback";
import { runTool, type ToolContext } from "../src/agent/tools";
import { addDays, resetClock, setNow } from "../src/clock";
import { DONATION_SITES, describeDonation, donationAdvice } from "../src/domain/donate";
import { importFoodKeeperFile } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { wasteSummary } from "../src/domain/ledger";
import { setupHousehold } from "./helpers";

const T0 = new Date("2026-11-14T15:00:00Z"); // 10:00 in New York

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

const status = (db: Database, name: string) => db.query<{ status: string }, [string]>("SELECT status FROM items WHERE name = ?").get(name)?.status;

afterEach(() => resetClock());

describe("the donation list", () => {
  test("every place has a name, address, contact, what it accepts, and when it was checked", () => {
    expect(DONATION_SITES.length).toBeGreaterThan(0);
    for (const s of DONATION_SITES) {
      expect(s.name && s.address && s.contact && s.how && s.checked).toBeTruthy();
      expect(s.accepts.length).toBeGreaterThan(0);
    }
  });
});

describe("what can be donated, and where", () => {
  test("shelf-stable food goes to a pantry that takes non-perishables, sealed only", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "rice", state: "raw" }] }, ctx);
    const r = runTool("find_donation_spot", { item: "rice" }, ctx);
    expect(String(r.message)).toContain("The rice can be donated. Only if it's sealed and unopened.");
    expect(String(r.message)).toContain("Arm In Arm");
    expect(String(r.message)).toContain("61 Nassau St");
    expect(String(r.message)).not.toContain("Mobile Food Pantry");
  });

  test("fresh food: no drop-off; offer it to the house, or arrange it first", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "spinach", state: "raw" }] }, ctx);
    const msg = String(runTool("find_donation_spot", { item: "spinach" }, ctx).message);
    expect(msg).toContain("don't take fresh food as a drop-off. Offer it to the house first.");
    expect(msg).toContain("Princeton Mobile Food Pantry");
    expect(msg).not.toContain("Arm In Arm");
  });

  test("food past its USDA date is never suggested for donation, and can't be logged as donated", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "chicken thighs", state: "raw" }] }, ctx);
    setNow(addDays(T0, 5)); // chicken keeps 1-2 days in the fridge
    expect(String(runTool("find_donation_spot", { item: "chicken thighs" }, ctx).message)).toContain("can't be donated. To be safe, toss it.");
    expect(runTool("donated_item", { item: "chicken thighs" }, ctx)).toMatchObject({ done: false });
    expect(status(db, "chicken thighs")).toBe("fresh");
  });

  test("no item: lists every place, with the sealed-and-in-date rule", () => {
    const msg = describeDonation(donationAdvice(null));
    for (const s of DONATION_SITES) expect(msg).toContain(s.name);
    expect(msg).toContain("sealed, unopened");
  });

  test("a personal item asked about in the group: answered by DM, not named in the group", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db, 1);
    runTool("add_item", { items: [{ name: "pasta", state: "raw", mine: true }] }, ctx);
    const r = runTool("find_donation_spot", { item: "pasta" }, ctx);
    if (r.sent_privately) {
      expect(ctx.drafts.at(-1)).toMatchObject({ audience: { kind: "member", memberId: 2 } });
      expect(JSON.stringify(r)).not.toContain("pasta");
    } else {
      expect(String(r.message)).toContain("pasta"); // shared after all (add_item decided): fine to name
    }
  });
});

describe("logging a donation", () => {
  test("'I donated the rice' takes it off the list and counts as a rescue, even if it wasn't expiring", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "rice", state: "raw" }] }, ctx);
    const r = runTool("donated_item", { item: "rice" }, ctx);
    expect(r).toMatchObject({ done: true });
    expect(String(r.message)).toContain("counts as a rescue");
    expect(status(db, "rice")).toBe("used");
    expect(wasteSummary(db, 1).rescued.count).toBe(1);
    expect(wasteSummary(db, 1).wasted.count).toBe(0);
  });
});

describe("rule-based path (and fact questions answered by code)", () => {
  test("phrasings", () => {
    expect(parseIntent("where can I donate the rice?")).toEqual({ kind: "donate", item: "rice" });
    expect(parseIntent("Thyme where can we donate food", "Thyme")).toEqual({ kind: "donate" });
    expect(parseIntent("is there a food pantry near us?")).toEqual({ kind: "donate" });
    expect(parseIntent("can we give away the bread")).toEqual({ kind: "donate", item: "bread" });
    expect(parseIntent("I donated the rice")).toEqual({ kind: "donated", item: "rice" });
    expect(parseIntent("we gave the bread away")).toEqual({ kind: "donated", item: "bread" });
    expect(parseIntent("gave away the pasta to Arm in Arm")).toEqual({ kind: "donated", item: "pasta" });
    expect(parseIntent("what's in the pantry")?.kind).toBe("inventory");
  });

  test("the fallback answers with the fixed wording", async () => {
    const db = await kitchen();
    const ctx = ctxFor(db);
    runTool("add_item", { items: [{ name: "rice", state: "raw" }] }, ctx);
    expect(await runFallback("where can I donate the rice?", ctx, "Thyme")).toContain("Arm In Arm");
    expect(await runFallback("I donated the rice", ctx, "Thyme")).toContain("counts as a rescue");
    expect(describeToolResult("donated_item", { done: false })).toContain("couldn't find");
  });
});
