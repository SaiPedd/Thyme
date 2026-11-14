// USDA FoodKeeper: parse the official JSON, normalize shelf life to days, load into shelf_life,
// and compute expiry dates. Expiry dates come ONLY from here, never from Claude (CLAUDE.md).
// Source: https://www.fsis.usda.gov/shared/data/EN/foodkeeper.json (FSIS, public domain).

import type { Database } from "bun:sqlite";
import { addDays } from "./clock";

export type Storage = "pantry" | "fridge" | "freezer";

export interface ShelfLifeRow {
  id: number;
  category: string | null;
  name: string;
  subtitle: string | null;
  keywords: string | null;
  pantry_min_days: number | null;
  pantry_max_days: number | null;
  fridge_min_days: number | null;
  fridge_max_days: number | null;
  freezer_min_days: number | null;
  freezer_max_days: number | null;
  /** USDA guidance with no number ("Package use-by date", "When Ripe", ...). Null when days are known. */
  pantry_note: string | null;
  fridge_note: string | null;
  freezer_note: string | null;
}

const DAYS_PER: Record<string, number> = {
  hour: 1 / 24,
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

/** Convert a FoodKeeper amount + metric ("Days", "Weeks", ...) to whole days. Null if not a time unit. */
export function toDays(amount: unknown, metric: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof metric !== "string") return null;
  const unit = metric.trim().toLowerCase().replace(/s$/, "");
  const factor = DAYS_PER[unit];
  if (factor === undefined) return null;
  return Math.max(1, Math.ceil(amount * factor));
}

type Raw = Record<string, unknown>;

/** FoodKeeper rows are arrays of single-key objects: [{ID: 1}, {Name: "Butter"}, ...]. Flatten to one object. */
function flatten(row: unknown): Raw {
  if (Array.isArray(row)) return Object.assign({}, ...row.filter((c) => c && typeof c === "object"));
  return (row ?? {}) as Raw;
}

function sheet(json: unknown, name: string): Raw[] {
  const sheets = (json as { sheets?: { name?: string; data?: unknown[] }[] })?.sheets;
  const found = sheets?.find((s) => s.name === name);
  if (!found?.data) throw new Error(`FoodKeeper JSON: missing "${name}" sheet`);
  return found.data.map(flatten);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Shelf life for one storage, preferring the general range and falling back to "from date of purchase" (DOP_).
 * When neither has a number, returns the first non-time metric as a note (e.g. "Package use-by date").
 */
function range(p: Raw, key: "Pantry" | "Refrigerate" | "Freeze"): [number | null, number | null, string | null] {
  let note: string | null = null;
  for (const prefix of [key, `DOP_${key}`]) {
    const metric = p[`${prefix}_Metric`];
    const min = toDays(p[`${prefix}_Min`], metric);
    const max = toDays(p[`${prefix}_Max`], metric);
    if (min !== null || max !== null) return [min ?? max, max ?? min, null];
    note ??= str(metric);
  }
  return [null, null, note];
}

/** Parse the official FoodKeeper JSON into shelf_life rows. */
export function parseFoodKeeper(json: unknown): ShelfLifeRow[] {
  const categories = new Map<number, string>();
  for (const c of sheet(json, "Category")) {
    const id = Number(c.ID);
    const label = [str(c.Category_Name), str(c.Subcategory_Name)].filter(Boolean).join(" / ");
    if (Number.isFinite(id) && label) categories.set(id, label);
  }

  const rows: ShelfLifeRow[] = [];
  for (const p of sheet(json, "Product")) {
    const id = Number(p.ID);
    const name = str(p.Name);
    if (!Number.isFinite(id) || !name) continue;
    const [pantryMin, pantryMax, pantryNote] = range(p, "Pantry");
    const [fridgeMin, fridgeMax, fridgeNote] = range(p, "Refrigerate");
    const [freezerMin, freezerMax, freezerNote] = range(p, "Freeze");
    rows.push({
      id,
      category: categories.get(Number(p.Category_ID)) ?? null,
      name,
      subtitle: str(p.Name_subtitle),
      keywords: str(p.Keywords),
      pantry_min_days: pantryMin,
      pantry_max_days: pantryMax,
      fridge_min_days: fridgeMin,
      fridge_max_days: fridgeMax,
      freezer_min_days: freezerMin,
      freezer_max_days: freezerMax,
      pantry_note: pantryNote,
      fridge_note: fridgeNote,
      freezer_note: freezerNote,
    });
  }
  if (rows.length === 0) throw new Error("FoodKeeper JSON: no products parsed");
  return rows;
}

/** Replace the shelf_life table contents in one transaction. Returns the row count. */
export function loadShelfLife(db: Database, rows: ShelfLifeRow[]): number {
  const insert = db.prepare(
    `INSERT INTO shelf_life (id, category, name, subtitle, keywords,
       pantry_min_days, pantry_max_days, fridge_min_days, fridge_max_days, freezer_min_days, freezer_max_days,
       pantry_note, fridge_note, freezer_note)
     VALUES ($id, $category, $name, $subtitle, $keywords,
       $pantry_min_days, $pantry_max_days, $fridge_min_days, $fridge_max_days, $freezer_min_days, $freezer_max_days,
       $pantry_note, $fridge_note, $freezer_note)`,
  );
  db.transaction(() => {
    db.run("DELETE FROM shelf_life");
    for (const row of rows) insert.run({ ...row });
  })();
  return rows.length;
}

export const DEFAULT_FOODKEEPER_PATH = "data/foodkeeper.json";

/** Read and import a FoodKeeper JSON file. Returns the row count. */
export async function importFoodKeeperFile(db: Database, path: string = DEFAULT_FOODKEEPER_PATH): Promise<number> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${path} not found. Download https://www.fsis.usda.gov/shared/data/EN/foodkeeper.json there.`);
  }
  return loadShelfLife(db, parseFoodKeeper(await file.json()));
}

/** Import FoodKeeper only when shelf_life is empty (first run / fresh clone). Returns rows imported, 0 if skipped. */
export async function ensureShelfLife(db: Database, path: string = DEFAULT_FOODKEEPER_PATH): Promise<number> {
  const { n } = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shelf_life").get()!;
  return n > 0 ? 0 : importFoodKeeperFile(db, path);
}

/** Conservative shelf life (the minimum) for a storage. Null when FoodKeeper has no entry for it. */
export function shelfLifeDays(row: ShelfLifeRow, storage: Storage): number | null {
  if (storage === "pantry") return row.pantry_min_days;
  if (storage === "fridge") return row.fridge_min_days;
  return row.freezer_min_days;
}

/** Expiry date = added time + conservative shelf life. Null when the storage isn't listed. */
export function expiryFor(row: ShelfLifeRow, storage: Storage, addedAt: Date): Date | null {
  const days = shelfLifeDays(row, storage);
  return days === null ? null : addDays(addedAt, days);
}
