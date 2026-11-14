// One-time import: data/foodkeeper.json (USDA FSIS, public domain) -> shelf_life table.
// Usage: bun run load-foodkeeper [path/to/foodkeeper.json]

import { openDb } from "../src/db";
import { loadShelfLife, parseFoodKeeper } from "../src/foodkeeper";

const path = process.argv[2] ?? "data/foodkeeper.json";
const file = Bun.file(path);
if (!(await file.exists())) {
  console.error(`[foodkeeper] ${path} not found. Download https://www.fsis.usda.gov/shared/data/EN/foodkeeper.json there.`);
  process.exit(1);
}

const rows = parseFoodKeeper(await file.json());
const db = openDb();
const count = loadShelfLife(db, rows);
const withFridge = rows.filter((r) => r.fridge_min_days !== null).length;
console.log(`[foodkeeper] loaded ${count} products (${withFridge} with fridge shelf life)`);
db.close();
