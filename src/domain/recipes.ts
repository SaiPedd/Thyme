// Recipes from what's actually in the kitchen. Code checks every ingredient against the inventory
// (plus salt, oil, and water), skips anything past its USDA date, and honors diets, dislikes,
// and allergies. The model may propose a recipe; it's only suggested if validateRecipe passes.

import { readFileSync } from "node:fs";
import { isAtRisk, isPast, nameWords, type Item } from "./inventory";
import { conflict, KNOWN_DIETS, type Pref } from "./prefs";

export interface Recipe {
  title: string;
  needs: string[];
  optional?: string[];
  steps: string[];
}

export const RECIPES: Recipe[] = (JSON.parse(readFileSync(new URL("../../data/recipes.json", import.meta.url), "utf8")) as { recipes: Recipe[] }).recipes;

/** Assumed in every kitchen (PLAN.md: "plus salt and oil"). */
export function isStaple(ingredient: string): boolean {
  const w = nameWords(ingredient);
  return w.length > 0 && (w.join(" ") === "salt" || w.join(" ") === "water" || w.at(-1) === "oil");
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

/** Saved diets we can't check in code, so the reply can say so. */
export function uncheckedDiets(prefs: Pref[]): string[] {
  return [...new Set(prefs.filter((p) => p.kind === "diet" && !(KNOWN_DIETS as readonly string[]).includes(p.value)).map((p) => p.value))];
}
