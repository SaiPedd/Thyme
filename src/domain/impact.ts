// Rough weight and climate impact of food, by USDA FoodKeeper category. These are estimates for the
// waste report, never facts about a specific item.
//
// Source for kg CO2e per kg of food: Poore, J. & Nemecek, T. (2018), "Reducing food's environmental
// impacts through producers and consumers", Science 360(6392), via Our World in Data
// ("Greenhouse gas emissions per kilogram of food product"). Each category uses a rounded
// average of the products it mostly contains (e.g. Meat mixes beef, pork, and lamb).
// Weights per item are typical US package sizes.

export interface Impact {
  grams: number;
  co2Grams: number;
}

const LB = 453.6;

/** FoodKeeper Category_Name -> typical pounds per item and kg CO2e per kg. */
const FACTORS: Record<string, { lbPerItem: number; kgCo2ePerKg: number }> = {
  "Baby Food": { lbPerItem: 0.5, kgCo2ePerKg: 2 },
  "Baked Goods": { lbPerItem: 1, kgCo2ePerKg: 1.6 },
  Beverages: { lbPerItem: 2, kgCo2ePerKg: 1 },
  "Condiments, Sauces & Canned Goods": { lbPerItem: 1, kgCo2ePerKg: 2 },
  "Dairy Products & Eggs": { lbPerItem: 2, kgCo2ePerKg: 5 },
  "Deli & Prepared Foods": { lbPerItem: 1, kgCo2ePerKg: 6 },
  "Food Purchased Frozen": { lbPerItem: 1, kgCo2ePerKg: 3 },
  "Grains, Beans & Pasta": { lbPerItem: 1, kgCo2ePerKg: 2.5 },
  Meat: { lbPerItem: 1.5, kgCo2ePerKg: 30 },
  Poultry: { lbPerItem: 1.5, kgCo2ePerKg: 9.9 },
  Produce: { lbPerItem: 1, kgCo2ePerKg: 0.8 },
  Seafood: { lbPerItem: 1, kgCo2ePerKg: 13.6 },
  "Shelf Stable Foods": { lbPerItem: 1, kgCo2ePerKg: 2 },
  "Vegetarian Proteins": { lbPerItem: 1, kgCo2ePerKg: 3.2 },
};

const DEFAULT = { lbPerItem: 1, kgCo2ePerKg: 2.5 };

/** Impact of one item. `category` is the shelf_life label, e.g. "Produce / Fresh". */
export function impactFor(category: string | null): Impact {
  const top = (category ?? "").split(" / ")[0]!.trim();
  const f = FACTORS[top] ?? DEFAULT;
  const grams = Math.round(f.lbPerItem * LB);
  return { grams, co2Grams: Math.round(grams * f.kgCo2ePerKg) };
}

/** 1361 -> "3 lb", 680 -> "1.5 lb" */
export function formatPounds(grams: number): string {
  const lb = Math.round((grams / LB) * 10) / 10;
  return `${lb} lb`;
}

/** 12340 -> "12.3 kg CO2e" */
export function formatCo2(grams: number): string {
  return `${Math.round(grams / 100) / 10} kg CO2e`;
}
