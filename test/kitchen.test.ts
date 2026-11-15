// Kitchen companion: recipes only from inventory, preferences honored, allergy privacy,
// "I cooked it" with confirmation, "forget me".

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { parseIntent } from "../src/agent/fallback";
import { runTool, type ToolContext } from "../src/agent/tools";
import { addDays, advanceDays, resetClock, setNow } from "../src/clock";
import { importFoodKeeperFile } from "../src/domain/foodkeeper";
import { getHousehold, getMembers, parseNameIntro } from "../src/domain/household";
import { addItem, type Item } from "../src/domain/inventory";
import { conflict, savePref } from "../src/domain/prefs";
import { isStaple, pickRecipes, RECIPES, validateRecipe } from "../src/domain/recipes";
import { Inbox } from "../src/inbox";
import { Outbox } from "../src/outbox";
import { makeRouter } from "../src/router";
import { FakeAdapter, PHONES, quietLog, setupHousehold } from "./helpers";

const T0 = new Date("2026-11-14T15:00:00Z"); // 10:00 New York
afterEach(() => resetClock());

async function kitchen(foods: string[], ownerId: number | null = null): Promise<Database> {
  const db = setupHousehold();
  await importFoodKeeperFile(db);
  setNow(T0);
  for (const f of foods) {
    const r = addItem(db, { householdId: 1, name: f, buyerId: 1, ownerId, state: "raw" });
    if (!r.ok) throw new Error(`couldn't add ${f}`);
  }
  return db;
}

function ctxFor(db: Database, memberIndex = 0, isGroup = true): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup, chatId: isGroup ? "chat-1" : `dm-${memberIndex}`, drafts: [] };
}

const items = (db: Database) => db.query<Item, []>("SELECT * FROM items WHERE status = 'fresh' ORDER BY expires_at").all();

describe("recipe validation", () => {
  test("every ingredient must be in the kitchen; salt, oil, and water are assumed", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    expect(validateRecipe(["eggs", "spinach", "salt", "olive oil"], items(db), []).ok).toBe(true);
    const bad = validateRecipe(["eggs", "spinach", "feta"], items(db), []);
    expect(bad.ok).toBe(false);
    expect(bad.missing).toEqual(["feta"]);
    expect(isStaple("black pepper")).toBe(false); // "salt and oil" only
  });

  test("food past its USDA date is never used", async () => {
    const db = await kitchen(["eggs", "strawberries"]);
    advanceDays(5); // strawberries (2 days) are past; eggs aren't
    expect(validateRecipe(["strawberries"], items(db), []).missing).toEqual(["strawberries"]);
  });

  test("every built-in pick uses only what's in the kitchen", async () => {
    const db = await kitchen(["eggs", "baby spinach", "rice", "bananas", "milk", "bread", "cheese"]);
    const names = items(db).map((i) => i.name);
    const picks = pickRecipes(items(db), []);
    expect(picks.length).toBeGreaterThan(3);
    for (const p of picks) {
      for (const c of p.check.checks) expect(c.staple || names.includes(c.item!)).toBe(true);
    }
  });

  test("prefers food about to expire", async () => {
    const db = await kitchen(["eggs", "rice", "bananas"]);
    advanceDays(1); // bananas (3 days) are now within 48h
    expect(pickRecipes(items(db), [])[0]!.recipe.title).toBe("Banana pancakes");
  });

  test("every recipe in data/recipes.json is well-formed", () => {
    for (const r of RECIPES) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.needs.length).toBeGreaterThan(0);
      expect(r.steps.length).toBeGreaterThan(0);
    }
  });
});

describe("preferences", () => {
  test("diet, dislike, and allergy conflicts", () => {
    expect(conflict("chicken thighs", { kind: "diet", value: "vegetarian" })).toBe("not vegetarian");
    expect(conflict("eggs", { kind: "diet", value: "vegetarian" })).toBeNull();
    expect(conflict("eggs", { kind: "diet", value: "vegan" })).toBe("not vegan");
    expect(conflict("oat milk", { kind: "diet", value: "vegan" })).toBeNull();
    expect(conflict("mushrooms", { kind: "dislike", value: "mushroom" })).toBe("disliked");
    expect(conflict("peanut butter", { kind: "allergy", value: "peanuts" })).toBe("allergy");
    expect(conflict("cheddar cheese", { kind: "allergy", value: "dairy" })).toBe("allergy");
    expect(conflict("bread", { kind: "allergy", value: "gluten" })).toBe("allergy");
  });

  test("recipes honor everyone eating: a vegetarian never gets chicken, and an egg allergy rules out eggs", async () => {
    const db = await kitchen(["chicken", "rice", "eggs", "baby spinach"]);
    savePref(db, 2, "diet", "vegetarian");
    const sam = runTool("suggest_recipe", {}, ctxFor(db, 1, false)) as any;
    expect(sam.ok).toBe(true);
    expect(JSON.stringify(sam.ingredients)).not.toContain("chicken");

    savePref(db, 3, "allergy", "eggs");
    const both = runTool("suggest_recipe", { for: ["Sam", "Jordan"] }, ctxFor(db, 1, false)) as any;
    expect(JSON.stringify(both.ingredients ?? [])).not.toMatch(/chicken|egg/);
  });

  test("a model-proposed recipe that breaks a preference or uses missing food is rejected", async () => {
    const db = await kitchen(["chicken", "rice"]);
    savePref(db, 1, "diet", "vegetarian");
    const r = runTool("suggest_recipe", { recipe: { title: "Chicken bowl", ingredients: ["chicken", "rice", "avocado"], steps: ["cook"] } }, ctxFor(db, 0, false)) as any;
    expect(r.ok).toBe(false);
    expect(r.missing_from_kitchen).toEqual(["avocado"]);
    expect(r.conflicts).toEqual(["chicken: not vegetarian"]);
  });

  test("in the group, allergies are never tied to a name, and prefs aren't echoed", async () => {
    const db = await kitchen(["eggs", "baby spinach", "rice"]);
    const save = ctxFor(db, 2, true);
    const saved = runTool("save_preference", { kind: "allergy", value: "peanuts" }, save);
    expect(JSON.stringify(saved)).not.toContain("peanut");

    const r = runTool("suggest_recipe", { for: ["everyone"] }, ctxFor(db, 0, true));
    const out = JSON.stringify(r);
    expect(out).not.toContain("Jordan");
    expect(out).toContain("can't promise");

    const mine = ctxFor(db, 2, true);
    expect(runTool("get_preferences", {}, mine)).toMatchObject({ sent_privately: true });
    expect(mine.drafts[0]).toMatchObject({ audience: { kind: "member", memberId: 3 }, sensitivity: "personal" });
  });

  test("'I'm vegetarian' is a preference, not a name", () => {
    expect(parseNameIntro("I'm vegetarian")).toBeNull();
    expect(parseNameIntro("I'm vegan")).toBeNull();
    expect(parseIntent("I'm vegetarian")).toEqual({ kind: "pref", pref: "diet", value: "vegetarian" });
    expect(parseIntent("I'm allergic to peanuts")).toEqual({ kind: "pref", pref: "allergy", value: "peanuts" });
    expect(parseIntent("I hate mushrooms")).toEqual({ kind: "pref", pref: "dislike", value: "mushrooms" });
    expect(parseIntent("what can I make tonight?")).toEqual({ kind: "recipe" });
    expect(parseIntent("is the spinach still good?")).toEqual({ kind: "check", item: "spinach" });
  });
});

describe("over chat (fallback rules)", () => {
  async function app() {
    const db = await kitchen(["eggs", "baby spinach", "rice"]);
    db.run("INSERT INTO state (key, value) VALUES ('intro:chat-1', 't')");
    const adapter = new FakeAdapter();
    const outbox = new Outbox(db, adapter, { sleep: async () => {}, log: quietLog });
    const router = makeRouter({ db, outbox, adapter, botName: "Thyme", model: "x", client: null, log: quietLog });
    const inbox = new Inbox(db, router, { debounceMs: 5 });
    await adapter.start({ onMessage: (m) => inbox.push(m) });
    const say = async (from: string, text: string, isGroup = true) => {
      adapter.receive({ from, text, isGroup });
      await new Promise((r) => setTimeout(r, 30));
      await inbox.drain();
      return adapter.sent.at(-1)?.text ?? "";
    };
    return { db, adapter, say };
  }

  test("what can I make -> I made it -> yes marks the ingredients used", async () => {
    const { db, adapter, say } = await app();
    const idea = await say(PHONES[0]!, "Thyme, what can I make tonight?");
    expect(idea).toMatch(/^Try /);
    expect(idea).not.toMatch(/chicken|feta|tomato/);

    // A bare "yes" in the group is ignored when nothing is waiting for one.
    const before = adapter.sent.length;
    await say(PHONES[1]!, "yes");
    expect(adapter.sent.length).toBe(before);

    expect(await say(PHONES[0]!, "I made it")).toContain(`Reply "yes"`);
    expect(await say(PHONES[0]!, "yes")).toMatch(/^Done: marked the/);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM items WHERE status = 'used'").get()!.n).toBeGreaterThan(0);
  });

  test("forget me deletes prefs and history, keeps money", async () => {
    const { db, say } = await app();
    await say(PHONES[0]!, "I hate mushrooms", false);
    await say(PHONES[0]!, "groceries $30", false);
    expect(await say(PHONES[0]!, "forget me", false)).toContain("deleted");
    expect(db.query("SELECT COUNT(*) AS n FROM prefs WHERE member_id = 1").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM turns WHERE member_id = 1").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM expenses").get()).toEqual({ n: 1 });
  });

  test("is it still good: past the USDA date says toss", async () => {
    const { say } = await app();
    expect(await say(PHONES[0]!, "is the spinach still good?")).toContain("If it looks, smells, or feels off, toss it");
    setNow(addDays(T0, 10));
    expect(await say(PHONES[0]!, "is the spinach still good?")).toContain("toss it");
  });
});
