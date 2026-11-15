// Recipes from what's actually in the kitchen. Code checks every ingredient against the inventory
// (plus salt, oil, and water), skips anything past its USDA date, and honors diets, dislikes,
// and allergies. The model may propose a recipe; it's only suggested if validateRecipe passes.

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { isAtRisk, isPast, nameWords, type Item } from "./inventory";
import { mealById, mealIdsFor, type MealDbClient, type MealDbRecipe } from "./mealdb";
import { conflict, KNOWN_DIETS, type Pref } from "./prefs";

export interface Recipe {
  title: string;
  needs: string[];
  optional?: string[];
  steps: string[];
}

export const RECIPES: Recipe[] = (JSON.parse(readFileSync(new URL("../../data/recipes.json", import.meta.url), "utf8")) as { recipes: Recipe[] }).recipes;

// Assumed in every kitchen: salt, pepper, garlic, dried spices and herbs, oils, and pantry basics.
// Fresh perishables (fresh herbs, butter, milk, eggs...) are NOT staples; they must be in the inventory.
const STAPLE_PHRASES = new Set([
  "salt", "sea salt", "pepper", "black pepper", "white pepper", "salt and pepper", "water", "ice",
  "garlic", "garlic clove", "garlic powder", "onion powder", "sugar", "brown sugar", "caster sugar", "icing sugar",
  "flour", "plain flour", "all purpose flour", "self raising flour", "cornstarch", "cornflour", "baking powder",
  "baking soda", "bicarbonate soda", "yeast", "vinegar", "soy sauce", "worcestershire sauce", "honey",
  "stock cube", "chicken stock cube", "vegetable stock cube", "beef stock cube", "bay leaf", "vanilla extract", "mustard",
  "tomato puree", "tomato paste", "hot sauce", "sriracha", "onion", "brown onion", "yellow onion", "white onion",
  "stock", "chicken stock", "vegetable stock", "beef stock", "fish stock", "broth", "chicken broth", "vegetable broth",
]);
// Spices and common (dried) herbs. "fresh X" is never a staple.
const SPICE_WORDS = new Set([
  "paprika", "cumin", "turmeric", "cinnamon", "nutmeg", "oregano", "cayenne", "chilli", "chili", "garam", "masala",
  "coriander", "cardamom", "clove", "allspice", "fenugreek", "spice", "seasoning", "powder", "flake",
  "thyme", "rosemary", "parsley", "sage", "dill", "bay", "leaf", "herb",
]);

/** Assumed in every kitchen. Oils, "dried X", "ground X", and spices count as staples. */
export function isStaple(ingredient: string): boolean {
  const w = nameWords(ingredient);
  if (w.length === 0) return false;
  const phrase = w.join(" ");
  if (STAPLE_PHRASES.has(phrase)) return true;
  if (w.at(-1) === "oil" || w.at(-1) === "vinegar") return true;
  if (w[0] === "dried" || w[0] === "ground") return true;
  // A spice word alone or as the last word ("smoked paprika", "chilli flakes"); not "fresh coriander".
  return w[0] !== "fresh" && SPICE_WORDS.has(w.at(-1)!);
}

/** The inventory item an ingredient refers to: every word of the ingredient appears in the item's name. */
export function itemFor(ingredient: string, items: Item[]): Item | null {
  const q = nameWords(ingredient);
  if (q.length === 0) return null;
  const hits = items.filter((i) => {
    const w = nameWords(i.name);
    return q.every((x) => w.includes(x));
  });
  // Soonest to expire first (items arrive sorted that way), so recipes rescue food.
  return hits[0] ?? null;
}

/** Items a recipe may use: fresh and not past their USDA date. */
export function usableItems(items: Item[], at?: Date): Item[] {
  return items.filter((i) => i.status === "fresh" && !isPast(i, at));
}

export interface IngredientCheck {
  ingredient: string;
  item?: string;
  staple?: boolean;
  missing?: boolean;
  /** "allergy" | "disliked" | "not vegetarian"... */
  conflict?: string;
}

export interface RecipeCheck {
  ok: boolean;
  checks: IngredientCheck[];
  missing: string[];
  conflicts: IngredientCheck[];
  itemIds: number[];
  expiringUsed: string[];
}

function checkOne(ingredient: string, items: Item[], prefs: Pref[]): IngredientCheck {
  const c: IngredientCheck = { ingredient };
  const reasons = [...new Set(prefs.map((p) => conflict(ingredient, p)).filter((x): x is string => x !== null))];
  if (reasons.length) c.conflict = reasons.join(", ");
  if (isStaple(ingredient)) c.staple = true;
  else {
    const item = itemFor(ingredient, items);
    if (item) c.item = item.name;
    else c.missing = true;
  }
  return c;
}

/** Check a proposed recipe: every ingredient in the kitchen (or a staple) and no preference conflicts. */
export function validateRecipe(ingredients: string[], items: Item[], prefs: Pref[]): RecipeCheck {
  const usable = usableItems(items);
  const checks = ingredients.filter((i) => i.trim()).map((i) => checkOne(i, usable, prefs));
  const used = checks.map((c) => usable.find((i) => i.name === c.item)).filter((i): i is Item => !!i);
  const missing = checks.filter((c) => c.missing).map((c) => c.ingredient);
  const conflicts = checks.filter((c) => c.conflict);
  return {
    ok: checks.length > 0 && missing.length === 0 && conflicts.length === 0,
    checks,
    missing,
    conflicts,
    itemIds: [...new Set(used.map((i) => i.id))],
    expiringUsed: [...new Set(used.filter((i) => isAtRisk(i)).map((i) => i.name))],
  };
}

export interface Suggestion {
  recipe: Recipe;
  /** needs + the optional ingredients that are in the kitchen and fit everyone's preferences. */
  ingredients: string[];
  check: RecipeCheck;
}

/** Best built-in recipe for this kitchen: all needed ingredients present, no conflicts; prefers food about to expire. */
export function pickRecipes(items: Item[], prefs: Pref[], exclude: string[] = []): Suggestion[] {
  const usable = usableItems(items);
  const out: (Suggestion & { score: number })[] = [];
  for (const recipe of RECIPES) {
    if (exclude.includes(recipe.title)) continue;
    const base = validateRecipe(recipe.needs, usable, prefs);
    if (!base.ok) continue;
    const extras = (recipe.optional ?? []).filter((o) => {
      const c = checkOne(o, usable, prefs);
      return !c.missing && !c.conflict && !c.staple;
    });
    const ingredients = [...recipe.needs, ...extras];
    const check = validateRecipe(ingredients, usable, prefs);
    const likes = prefs.filter((p) => p.kind === "like" && ingredients.some((i) => conflict(i, { kind: "dislike", value: p.value })));
    out.push({ recipe, ingredients, check, score: check.expiringUsed.length * 10 + check.itemIds.length + likes.length * 2 });
  }
  return out.sort((a, b) => b.score - a.score).map(({ score: _s, ...s }) => s);
}

// ---------- TheMealDB ----------

export interface MealDbPick {
  recipe: MealDbRecipe;
  /** Main (non-staple) ingredients the kitchen has, with the item they matched. */
  have: { ingredient: string; item: string }[];
  /** Main ingredients the kitchen doesn't have (computed by code). */
  missing: string[];
  staples: string[];
  itemIds: number[];
  expiringUsed: string[];
  /** have / main ingredients. */
  coverage: number;
  /** True when the kitchen has fewer than half the main ingredients (offered only if nothing better fits). */
  closeMatch: boolean;
}

/**
 * Score one MealDB recipe against the kitchen. Rejected (null) if any ingredient conflicts with a saved
 * diet, dislike, or allergy. Kept if the kitchen has half or more of its main ingredients, or, as a
 * clearly labeled "closest match", at least 2 of them and about a third.
 */
export function scoreMealDbRecipe(recipe: MealDbRecipe, items: Item[], prefs: Pref[]): MealDbPick | null {
  const usable = usableItems(items);
  const have: MealDbPick["have"] = [];
  const missing: string[] = [];
  const staples: string[] = [];
  const used: Item[] = [];
  for (const { name } of recipe.ingredients) {
    if (prefs.some((p) => conflict(name, p) !== null)) return null;
    if (isStaple(name)) {
      staples.push(name);
      continue;
    }
    const item = itemFor(name, usable);
    if (item) {
      have.push({ ingredient: name, item: item.name });
      used.push(item);
    } else missing.push(name);
  }
  const mains = have.length + missing.length;
  if (mains === 0 || have.length === 0) return null;
  const majority = have.length * 2 >= mains; // half or more of the main ingredients
  const close = have.length >= 2 && have.length * 3 >= mains; // closest-match floor
  if (!majority && !close) return null;
  return {
    recipe,
    have,
    missing,
    staples,
    itemIds: [...new Set(used.map((i) => i.id))],
    expiringUsed: [...new Set(used.filter((i) => isAtRisk(i)).map((i) => i.name))],
    coverage: have.length / mains,
    closeMatch: !majority,
  };
}

// Words that don't make a useful MealDB search on their own ("thigh", "baby").
const NOT_FOOD_WORDS = new Set([
  "baby", "fresh", "large", "small", "sliced", "diced", "raw", "cooked", "whole", "boneless", "skinless", "organic", "frozen",
  "leftover", "red", "green", "thigh", "breast", "fillet", "leg", "wing", "drumstick", "loin", "mince", "ground",
]);

/** What to search MealDB for, from one inventory item: the name as written (MealDB uses plurals), then its food words. */
export function searchTermsFor(itemName: string): string[] {
  const asWritten = itemName.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = nameWords(itemName).filter((w) => !NOT_FOOD_WORDS.has(w));
  return [...new Set([asWritten, ...words])].filter(Boolean);
}

export interface MealDbSearchOptions {
  /** Titles to skip ("something else"). */
  exclude?: string[];
  /** Total time budget for network calls; cached lookups are instant. */
  budgetMs?: number;
  maxQueries?: number;
  maxMeals?: number;
}

/**
 * MealDB recipes for this kitchen, best first. Searches by the items expiring soonest; meals that show up
 * for several items rank higher (a free stand-in for MealDB's premium multi-ingredient filter).
 * Network failures or a blown budget return what's ready so far (possibly nothing); never throws.
 */
export async function pickMealDbRecipes(
  db: Database,
  client: MealDbClient,
  items: Item[],
  prefs: Pref[],
  opts: MealDbSearchOptions = {},
): Promise<MealDbPick[]> {
  const usable = usableItems(items).filter((i) => !isStaple(i.name));
  if (usable.length === 0) return [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.budgetMs ?? 3500);
  try {
    const terms: string[] = [];
    for (const item of usable.slice(0, 3)) for (const t of searchTermsFor(item.name)) if (!terms.includes(t)) terms.push(t);
    const queries = terms.slice(0, opts.maxQueries ?? 5);
    const results = await Promise.allSettled(queries.map((t) => mealIdsFor(db, client, t, abort.signal)));

    const hits = new Map<string, number>();
    for (const r of results) if (r.status === "fulfilled") for (const id of new Set(r.value)) hits.set(id, (hits.get(id) ?? 0) + 1);
    const candidates = [...hits].sort((a, b) => b[1] - a[1]).slice(0, opts.maxMeals ?? 20).map(([id]) => id);

    const meals = await Promise.allSettled(candidates.map((id) => mealById(db, client, id, abort.signal)));
    const picks: MealDbPick[] = [];
    for (const m of meals) {
      if (m.status !== "fulfilled" || !m.value) continue;
      if (opts.exclude?.includes(m.value.title)) continue;
      const pick = scoreMealDbRecipe(m.value, items, prefs);
      if (pick) picks.push(pick);
    }
    // Real matches (half or more of the mains) always beat closest matches.
    const score = (p: MealDbPick) => (p.closeMatch ? 0 : 100) + p.expiringUsed.length * 10 + p.coverage * 5 + p.have.length - p.missing.length * 0.5;
    return picks.sort((a, b) => score(b) - score(a));
  } finally {
    clearTimeout(timer);
  }
}

/** Saved diets we can't check in code, so the reply can say so. */
export function uncheckedDiets(prefs: Pref[]): string[] {
  return [...new Set(prefs.filter((p) => p.kind === "diet" && !(KNOWN_DIETS as readonly string[]).includes(p.value)).map((p) => p.value))];
}
