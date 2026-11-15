// Force a re-import: data/foodkeeper.json (USDA FSIS, public domain) -> shelf_life table.
// Not needed normally: the bot imports automatically at startup when the table is empty.
// Usage: bun run load-foodkeeper [path/to/foodkeeper.json]

import { openDb } from "../src/db";
import { DEFAULT_FOODKEEPER_PATH, importFoodKeeperFile } from "../src/domain/foodkeeper";

const db = openDb();
try {
  const count = await importFoodKeeperFile(db, process.argv[2] ?? DEFAULT_FOODKEEPER_PATH);
  console.log(`[foodkeeper] loaded ${count} products`);
} catch (error) {
  console.error(`[foodkeeper] ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
