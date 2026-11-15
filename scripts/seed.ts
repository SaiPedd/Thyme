// Seed one household and a starting fridge. Re-running resets household data (keeps FoodKeeper,
// usage, and seen messages).
//
// Roommates:
//   default            none: they're added from the household group chat, and the agent asks their names
//   --demo             fictional Alex, Sam, Jordan (555-01xx numbers, never texted) for `bun run chat`
//   SEED_MEMBERS=...   "Alex:+1...,Sam:+1..." to pin specific people
// Optional HOUSEHOLD_CHAT_ID pins the household's Claw group chat; otherwise the first group chat the
// agent is used in is adopted.
// Usage: bun run seed [--demo]

import { addDays, now } from "../src/clock";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { ensureShelfLife, expiryFor, searchShelfLife, type ShelfLifeRow, type Storage } from "../src/domain/foodkeeper";
import { mask, normalizePhone } from "../src/domain/phone";

const { config } = loadConfig(process.env, { requireClaw: false });
const db = openDb(config.dbPath);
await ensureShelfLife(db);

let roommates: { name: string; phone: string }[] = [];
if (process.env.SEED_MEMBERS?.trim()) {
  roommates = process.env.SEED_MEMBERS.split(",").map((pair, i) => {
    const [name, raw] = pair.split(":").map((s) => s.trim());
    const phone = normalizePhone(raw ?? "");
    if (!name || !phone) throw new Error(`SEED_MEMBERS entry ${i + 1} must look like Name:+16095550101`);
    return { name, phone };
  });
} else if (process.argv.includes("--demo")) {
  roommates = ["Alex", "Sam", "Jordan"].map((name, i) => ({ name, phone: `+1609555010${i + 1}` }));
}
const memberIds = new Set(roommates.map((_, i) => i + 1));

const at = now();
const iso = at.toISOString();

db.transaction(() => {
  for (const t of ["turns", "claims", "nudges", "ledger", "balance_entries", "expense_shares", "expenses", "prefs", "items", "sends", "members", "households"]) {
    db.run(`DELETE FROM ${t}`);
  }
  db.run("DELETE FROM state WHERE key LIKE 'intro:%'"); // so the agent introduces itself again
  db.run("INSERT INTO households (id, name, chat_id, tz, mode, created_at) VALUES (1, 'Squad House', ?, ?, ?, ?)", [
    process.env.HOUSEHOLD_CHAT_ID?.trim() || null,
    config.householdTz,
    config.householdMode,
    iso,
  ]);
  roommates.forEach((r, i) =>
    db.run("INSERT INTO members (id, household_id, phone, name, created_at) VALUES (?, 1, ?, ?, ?)", [i + 1, r.phone, r.name, iso]),
  );
})();

// Starting inventory. Expiry comes from FoodKeeper (conservative low end), never typed in here.
const shelf = (id: number) => db.query<ShelfLifeRow, [number]>("SELECT * FROM shelf_life WHERE id = ?").get(id)!;
const items: { query: string; name: string; storage: Storage; owner: number | null; buyer: number; cents: number; boughtDaysAgo: number }[] = [
  { query: "bagged greens spinach", name: "baby spinach", storage: "fridge", owner: null, buyer: 1, cents: 399, boughtDaysAgo: 2 },
  { query: "chicken parts thighs", name: "chicken thighs", storage: "fridge", owner: 1, buyer: 1, cents: 900, boughtDaysAgo: 0 },
  { query: "eggs in shell", name: "eggs", storage: "fridge", owner: null, buyer: 2, cents: 449, boughtDaysAgo: 3 },
  { query: "rice white", name: "rice", storage: "pantry", owner: null, buyer: 2, cents: 299, boughtDaysAgo: 10 },
  { query: "bananas", name: "bananas", storage: "fridge", owner: null, buyer: 3, cents: 179, boughtDaysAgo: 1 },
];
for (const it of items) {
  const match = searchShelfLife(db, it.query, 1)[0];
  const added = addDays(at, -it.boughtDaysAgo);
  const expires = match ? expiryFor(shelf(match.id), it.storage, added) : null;
  db.run(
    `INSERT INTO items (household_id, name, shelf_life_id, storage, owner_member_id, buyer_member_id, qty, cost_cents, cost_source, added_at, expires_at, status)
     VALUES (1, ?, ?, ?, ?, ?, 1, ?, 'estimate', ?, ?, 'fresh')`,
    // Without seeded roommates, starting items are shared and have no recorded buyer.
    [it.name, match?.id ?? null, it.storage, it.owner !== null && memberIds.has(it.owner) ? it.owner : null,
      memberIds.has(it.buyer) ? it.buyer : null, it.cents, added.toISOString(), expires?.toISOString() ?? null],
  );
}

console.log(`[seed] household "Squad House" (${config.householdMode} mode, ${config.householdTz})`);
if (roommates.length === 0) console.log("[seed] no roommates yet: they're added from the group chat, and the agent asks their names");
for (const r of roommates) console.log(`[seed]   ${r.name} ${mask(r.phone)}`);
console.log(`[seed] ${items.length} starting items`);
db.close();
