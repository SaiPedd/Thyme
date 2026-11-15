// Pre-cache TheMealDB recipes so the demo doesn't depend on MealDB's latency.
// Caches the ingredient lookups and full meals for what's in the kitchen now, plus common groceries.
// Usage: bun run mealdb-warm [extra ingredient ...]
// Recipe data and imagery: TheMealDB (https://www.themealdb.com/).

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getHousehold } from "../src/domain/household";
import { makeMealDbClient, mealById, mealIdsFor } from "../src/domain/mealdb";
import { searchTermsFor } from "../src/domain/recipes";

const COMMON = ["chicken", "beef", "pork", "salmon", "eggs", "spinach", "rice", "pasta", "potatoes", "tomatoes", "onion", "mushrooms", "cheese", "broccoli", "carrots", "beans", "tofu", "bread", "milk", "bananas"];
const MEALS_PER_INGREDIENT = 8;

const { config } = loadConfig(process.env, { requireClaw: false });
const db = openDb(config.dbPath);
const client = makeMealDbClient(config.mealdbApiKey);

const household = getHousehold(db);
const kitchen = household
  ? db.query<{ name: string }, [number]>("SELECT DISTINCT name FROM items WHERE household_id = ? AND status = 'fresh'").all(household.id).map((r) => r.name)
  : [];
const terms = [...new Set([...kitchen.flatMap(searchTermsFor), ...COMMON, ...process.argv.slice(2)])];

let meals = 0;
let failed = 0;
for (const term of terms) {
  const signal = AbortSignal.timeout(8000);
  try {
    const ids = await mealIdsFor(db, client, term, signal);
    for (const id of ids.slice(0, MEALS_PER_INGREDIENT)) {
      if (await mealById(db, client, id, AbortSignal.timeout(8000))) meals++;
    }
    console.log(`[mealdb] ${term}: ${ids.length} recipes`);
  } catch (error) {
    failed++;
    console.log(`[mealdb] ${term}: failed (${(error as Error).message})`);
  }
}
console.log(`[mealdb] cached ${meals} meals for ${terms.length} ingredients${failed ? `, ${failed} failed` : ""}. Recipe data: TheMealDB.`);
db.close();
