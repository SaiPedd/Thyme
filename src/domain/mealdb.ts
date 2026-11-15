// TheMealDB (https://www.themealdb.com/api.php): recipe ideas for what's in the kitchen.
// Live API with a local SQLite cache, so repeat lookups are instant and the demo survives a slow network.
// Free test key "1" is for development / educational use; set MEALDB_API_KEY for a supporter key.
// Credit: "Recipe data and imagery: TheMealDB (https://www.themealdb.com/)".

import type { Database } from "bun:sqlite";
import { now } from "../clock";

export const MEALDB_CREDIT = "Recipe from TheMealDB (themealdb.com)";
const INGREDIENT_TTL_MS = 7 * 24 * 3600_000;
const MEAL_TTL_MS = 30 * 24 * 3600_000;

/** The HTTP slice we use, so tests can pass a fake. Returns parsed JSON. */
export interface MealDbFetch {
  (url: string, opts: { signal: AbortSignal }): Promise<unknown>;
}

export interface MealDbClient {
  base: string;
  fetchJson: MealDbFetch;
}

export function makeMealDbClient(apiKey = "1", fetchJson?: MealDbFetch): MealDbClient {
  return {
    base: `https://www.themealdb.com/api/json/v1/${encodeURIComponent(apiKey)}/`,
    fetchJson:
      fetchJson ??
      (async (url, { signal }) => {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`MealDB HTTP ${res.status}`);
        return res.json();
      }),
  };
}

/** A meal as TheMealDB returns it (only the fields we read). */
export type RawMeal = Record<string, string | null | undefined> & { idMeal: string; strMeal: string };

export interface MealDbRecipe {
  id: string;
  title: string;
  category: string | null;
  area: string | null;
  ingredients: { name: string; measure: string }[];
  steps: string[];
  url: string;
  thumb: string | null;
  source: string | null;
}

/** "Chicken Thighs" -> "chicken_thighs" (MealDB uses underscores for spaces). */
export function ingredientKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Pull strIngredient1..20 / strMeasure1..20 into a list; split instructions into short steps. */
export function toRecipe(meal: RawMeal): MealDbRecipe {
  const ingredients: { name: string; measure: string }[] = [];
  for (let n = 1; n <= 20; n++) {
    const name = (meal[`strIngredient${n}`] ?? "").trim();
    if (!name) continue;
    ingredients.push({ name, measure: (meal[`strMeasure${n}`] ?? "").trim() });
  }
  const steps = (meal.strInstructions ?? "")
    .split(/\r?\n+/)
    .map((s) => s.replace(/^\s*(step\s*\d+[:.)]?|\d+[.)])\s*/i, "").trim())
    .filter((s) => s.length > 2 && !/^step\s*\d*$/i.test(s));
  return {
    id: meal.idMeal,
    title: meal.strMeal.trim(),
    category: meal.strCategory ?? null,
    area: meal.strArea ?? null,
    ingredients,
    steps,
    url: `https://www.themealdb.com/meal/${meal.idMeal}`,
    thumb: meal.strMealThumb ?? null,
    source: meal.strSource || null,
  };
}

const fresh = (fetchedAt: string, ttl: number) => Date.parse(fetchedAt) + ttl > now().getTime();

/** Meal ids that use an ingredient (filter.php?i=). Cached per ingredient. */
export async function mealIdsFor(db: Database, client: MealDbClient, ingredient: string, signal: AbortSignal): Promise<string[]> {
  const key = ingredientKey(ingredient);
  if (!key) return [];
  const cached = db.query<{ meal_ids: string; fetched_at: string }, [string]>("SELECT meal_ids, fetched_at FROM mealdb_by_ingredient WHERE ingredient = ?").get(key);
  if (cached && fresh(cached.fetched_at, INGREDIENT_TTL_MS)) return JSON.parse(cached.meal_ids) as string[];
  const body = (await client.fetchJson(`${client.base}filter.php?i=${encodeURIComponent(key)}`, { signal })) as { meals?: { idMeal: string }[] | null };
  const ids = Array.isArray(body?.meals) ? body.meals.map((m) => String(m.idMeal)) : [];
  db.run(
    "INSERT INTO mealdb_by_ingredient (ingredient, meal_ids, fetched_at) VALUES (?, ?, ?) ON CONFLICT(ingredient) DO UPDATE SET meal_ids = excluded.meal_ids, fetched_at = excluded.fetched_at",
    [key, JSON.stringify(ids), now().toISOString()],
  );
  return ids;
}

/** Full meal by id (lookup.php?i=). Cached per meal. */
export async function mealById(db: Database, client: MealDbClient, id: string, signal: AbortSignal): Promise<MealDbRecipe | null> {
  const cached = db.query<{ data: string; fetched_at: string }, [string]>("SELECT data, fetched_at FROM mealdb_meals WHERE id = ?").get(id);
  if (cached && fresh(cached.fetched_at, MEAL_TTL_MS)) return toRecipe(JSON.parse(cached.data) as RawMeal);
  const body = (await client.fetchJson(`${client.base}lookup.php?i=${encodeURIComponent(id)}`, { signal })) as { meals?: RawMeal[] | null };
  const meal = Array.isArray(body?.meals) ? body.meals[0] : undefined;
  if (!meal?.idMeal || !meal.strMeal) return null;
  db.run(
    "INSERT INTO mealdb_meals (id, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
    [id, JSON.stringify(meal), now().toISOString()],
  );
  return toRecipe(meal);
}
