import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { describeToolResult } from "../src/agent/fallback";
import { withRecipeCredit } from "../src/agent/loop";
import { runToolAsync, type ToolContext } from "../src/agent/tools";
import { resetClock, setNow } from "../src/clock";
import { importFoodKeeperFile } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { addItem, type Item } from "../src/domain/inventory";
import { ingredientKey, makeMealDbClient, mealById, mealIdsFor, toRecipe, type RawMeal } from "../src/domain/mealdb";
import { savePref } from "../src/domain/prefs";
import { pickMealDbRecipes, scoreMealDbRecipe, searchTermsFor } from "../src/domain/recipes";
import { setupHousehold } from "./helpers";

const T0 = new Date("2026-11-14T15:00:00Z");
afterEach(() => resetClock());

function meal(id: string, title: string, ingredients: [string, string][], instructions = "Step 1\r\nCook it.\r\nServe."): RawMeal {
  const m: RawMeal = { idMeal: id, strMeal: title, strInstructions: instructions, strMealThumb: `https://img/${id}.jpg`, strCategory: "Test", strArea: "Test" };
  ingredients.forEach(([name, measure], i) => {
    m[`strIngredient${i + 1}`] = name;
    m[`strMeasure${i + 1}`] = measure;
  });
  m.strIngredient19 = "";
  m.strIngredient20 = null;
  return m;
}

const MEALS: Record<string, RawMeal> = {
  "1": meal("1", "Spinach Frittata", [["Eggs", "6"], ["Spinach", "200g"], ["Salt", "pinch"], ["Black Pepper", "pinch"], ["Feta", "100g"]]),
  "2": meal("2", "Chicken Stir Fry", [["Chicken Thighs", "500g"], ["Spinach", "1 bag"], ["Soy Sauce", "2 tbsp"], ["Garlic", "2 cloves"], ["Rice", "1 cup"]]),
  "3": meal("3", "Beef Wellington", [["Beef Fillet", "1kg"], ["Puff Pastry", "1 sheet"], ["Mushrooms", "300g"], ["Eggs", "1"]]),
};
const BY_INGREDIENT: Record<string, string[]> = {
  spinach: ["1", "2"],
  eggs: ["1", "3"],
  egg: ["1", "3"],
  chicken_thighs: ["2"],
  chicken: ["2"],
};

/** Fake MealDB: answers filter.php and lookup.php from the tables above, counting calls. */
function fakeMealDb(opts: { fail?: boolean; hang?: boolean } = {}) {
  const calls: string[] = [];
  const client = makeMealDbClient("1", async (url, { signal }) => {
    calls.push(url);
    if (opts.fail) throw new Error("network down");
    if (opts.hang) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const u = new URL(url);
    const q = u.searchParams.get("i") ?? "";
    if (u.pathname.endsWith("filter.php")) return { meals: (BY_INGREDIENT[q] ?? []).map((id) => ({ idMeal: id, strMeal: MEALS[id]!.strMeal })) || null };
    if (u.pathname.endsWith("lookup.php")) return { meals: MEALS[q] ? [MEALS[q]] : null };
    return { meals: null };
  });
  return { client, calls };
}

async function kitchen(foods: string[]): Promise<Database> {
  const db = setupHousehold();
  await importFoodKeeperFile(db);
  setNow(T0);
  for (const f of foods) {
    const r = addItem(db, { householdId: 1, name: f, buyerId: 1, ownerId: null, state: "raw" });
    if (!r.ok) throw new Error(`couldn't add ${f}`);
  }
  return db;
}
const items = (db: Database) => db.query<Item, []>("SELECT * FROM items WHERE status = 'fresh' ORDER BY expires_at").all();
function ctxFor(db: Database, mealdb: ToolContext["mealdb"], memberIndex = 0, isGroup = false): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup, chatId: "c", drafts: [], mealdb };
}

describe("MealDB parsing and cache", () => {
  test("toRecipe: ingredients 1..20 with measures, blank slots skipped, steps split, link built", () => {
    const r = toRecipe(MEALS["1"]!);
    expect(r.ingredients).toEqual([
      { name: "Eggs", measure: "6" },
      { name: "Spinach", measure: "200g" },
      { name: "Salt", measure: "pinch" },
      { name: "Black Pepper", measure: "pinch" },
      { name: "Feta", measure: "100g" },
    ]);
    expect(r.steps).toEqual(["Cook it.", "Serve."]);
    expect(r.url).toBe("https://www.themealdb.com/meal/1");
  });

  test("ingredient keys use underscores", () => {
    expect(ingredientKey("Chicken Thighs")).toBe("chicken_thighs");
    expect(ingredientKey("  baby spinach! ")).toBe("baby_spinach");
  });

  test("lookups are cached: the second call makes no request", async () => {
    const db = setupHousehold();
    const { client, calls } = fakeMealDb();
    const signal = new AbortController().signal;
    expect(await mealIdsFor(db, client, "spinach", signal)).toEqual(["1", "2"]);
    expect((await mealById(db, client, "2", signal))?.title).toBe("Chicken Stir Fry");
    const before = calls.length;
    await mealIdsFor(db, client, "Spinach", signal);
    await mealById(db, client, "2", signal);
    expect(calls.length).toBe(before);
    expect(calls[0]).toBe("https://www.themealdb.com/api/json/v1/1/filter.php?i=spinach");
  });

  test("search terms come from the item name", () => {
    expect(searchTermsFor("baby spinach")).toEqual(["baby spinach", "spinach"]);
    // As written first (MealDB uses plurals), then food words; cut words like "thigh" are skipped.
    expect(searchTermsFor("chicken thighs")).toEqual(["chicken thighs", "chicken"]);
  });
});

describe("MealDB recipe matching", () => {
  test("majority of main ingredients required; staples assumed; missing listed by code", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    const frittata = scoreMealDbRecipe(toRecipe(MEALS["1"]!), items(db), [])!;
    expect(frittata.have.map((h) => h.ingredient)).toEqual(["Eggs", "Spinach"]);
    expect(frittata.missing).toEqual(["Feta"]); // 2 of 3 mains
    expect(frittata.staples).toEqual(["Salt", "Black Pepper"]);
    expect(frittata.closeMatch).toBe(false);
    // Wellington: 1 of 4 mains (eggs) is neither half nor a closest match (needs 2+).
    expect(scoreMealDbRecipe(toRecipe(MEALS["3"]!), items(db), [])).toBeNull();
  });

  test("closest match: 2+ mains and about a third, labeled and ranked below real matches", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    const big = toRecipe(meal("9", "Big Bake", [["Eggs", "2"], ["Spinach", "1 bag"], ["Feta", "1"], ["Leeks", "2"], ["Cream", "1 cup"]]));
    const pick = scoreMealDbRecipe(big, items(db), [])!;
    expect(pick).toMatchObject({ closeMatch: true, missing: ["Feta", "Leeks", "Cream"] });
  });

  test("a saved dislike or allergy rules a recipe out entirely", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    expect(scoreMealDbRecipe(toRecipe(MEALS["1"]!), items(db), [{ kind: "allergy", value: "feta" } as any])).toBeNull();
  });

  test("picks rank meals that match several kitchen items", async () => {
    const db = await kitchen(["baby spinach", "chicken thighs", "rice"]);
    const { client } = fakeMealDb();
    const picks = await pickMealDbRecipes(db, client, items(db), []);
    expect(picks[0]!.recipe.title).toBe("Chicken Stir Fry");
    expect(picks[0]!.missing).toEqual([]); // soy sauce and garlic are staples
  });

  test("network failure or a blown budget returns nothing instead of throwing", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    expect(await pickMealDbRecipes(db, fakeMealDb({ fail: true }).client, items(db), [])).toEqual([]);
    const started = performance.now();
    expect(await pickMealDbRecipes(db, fakeMealDb({ hang: true }).client, items(db), [], { budgetMs: 100 })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("recipe credit", () => {
  test("code adds the TheMealDB link and credit if the model left them out", () => {
    const results = [{ name: "suggest_recipe", result: { source: "TheMealDB", link: "https://www.themealdb.com/meal/1", credit: "Recipe from TheMealDB (themealdb.com)" } }];
    expect(withRecipeCredit("How about a frittata?", results)).toBe(
      "How about a frittata?\nFull recipe: https://www.themealdb.com/meal/1\nRecipe from TheMealDB (themealdb.com)",
    );
    expect(withRecipeCredit("Frittata! https://www.themealdb.com/meal/1 (TheMealDB)", results)).toBe("Frittata! https://www.themealdb.com/meal/1 (TheMealDB)");
    expect(withRecipeCredit("Try the built-in omelette.", [{ name: "suggest_recipe", result: { ok: true } }])).toBe("Try the built-in omelette.");
  });

  test("covers the extra MealDB idea next to a built-in recipe, when the reply mentions it", () => {
    const results = [{
      name: "suggest_recipe",
      result: { ok: true, title: "Spinach omelette", mealdb_idea: { title: "Chinese Orange Chicken", link: "https://www.themealdb.com/meal/7", credit: "Recipe from TheMealDB (themealdb.com)" } },
    }];
    expect(withRecipeCredit("How about Chinese Orange Chicken? From TheMealDB.", results)).toBe(
      "How about Chinese Orange Chicken? From TheMealDB.\nFull recipe: https://www.themealdb.com/meal/7",
    );
    expect(withRecipeCredit("How about a spinach omelette?", results)).toBe("How about a spinach omelette?");
  });
});

describe("suggest_recipe with MealDB", () => {
  test("returns a MealDB recipe with have / also_need / link / credit", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    const r = (await runToolAsync("suggest_recipe", {}, ctxFor(db, fakeMealDb().client))) as any;
    expect(r).toMatchObject({ ok: true, source: "TheMealDB", title: "Spinach Frittata", link: "https://www.themealdb.com/meal/1" });
    expect(r.also_need).toEqual(["100g Feta"]);
    expect(r.have).toEqual(["6 Eggs", "200g Spinach (the baby spinach)"]);
    expect(r.credit).toContain("TheMealDB");
    const text = describeToolResult("suggest_recipe", r)!;
    expect(text).toContain("You'd also need: 100g Feta.");
    expect(text).toContain("https://www.themealdb.com/meal/1");
  });

  test("'something else' skips the last idea", async () => {
    const db = await kitchen(["eggs", "baby spinach", "chicken thighs", "rice"]);
    const { client } = fakeMealDb();
    const first = (await runToolAsync("suggest_recipe", {}, ctxFor(db, client))) as any;
    const second = (await runToolAsync("suggest_recipe", { another: true }, ctxFor(db, client))) as any;
    expect(second.title).not.toBe(first.title);
  });

  test("falls back to built-in recipes when MealDB is down or off", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    const down = (await runToolAsync("suggest_recipe", {}, ctxFor(db, fakeMealDb({ fail: true }).client))) as any;
    expect(down.ok).toBe(true);
    expect(down.source).toBeUndefined();
    const off = (await runToolAsync("suggest_recipe", {}, ctxFor(db, null))) as any;
    expect(off.ok).toBe(true);
  });

  test("everyone's preferences apply to MealDB picks", async () => {
    const db = await kitchen(["eggs", "baby spinach"]);
    savePref(db, getMembers(db, 1)[0]!.id, "dislike", "feta");
    const r = (await runToolAsync("suggest_recipe", {}, ctxFor(db, fakeMealDb().client))) as any;
    expect(r.title).not.toBe("Spinach Frittata");
  });
});
