// Move the demo clock. The offset is saved in the database, so a running agent (`bun run chat` or
// `bun run start`) picks it up within 5 seconds and runs the scheduler: the 09:00 reminders fire
// on the new day. `bun run seed` resets it to real time.
// Usage: bun run time-travel +2d | +1d6h | +3h | reset

import { getOffsetMs, now, setOffsetMs } from "../src/clock";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getHousehold } from "../src/domain/household";
import { AT_RISK_MS, isPast, type Item } from "../src/domain/inventory";
import { CLOCK_OFFSET_KEY, DAILY_HOUR, syncClockFromDb } from "../src/scheduler";

const arg = process.argv[2]?.trim() ?? "";
const { config } = loadConfig(process.env, { requireClaw: false });
const db = openDb(config.dbPath);
syncClockFromDb(db);

let deltaMs = 0;
if (arg === "reset") {
  deltaMs = -getOffsetMs();
} else {
  const m = arg.match(/^([+-])?(?:(\d+)d)?(?:(\d+)h)?$/i);
  if (!m || (!m[2] && !m[3])) {
    console.error("usage: bun run time-travel +2d | +1d6h | +3h | reset");
    process.exit(1);
  }
  deltaMs = (m[1] === "-" ? -1 : 1) * ((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 3_600_000);
}

setOffsetMs(getOffsetMs() + deltaMs);
db.run("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [CLOCK_OFFSET_KEY, String(getOffsetMs())]);

const household = getHousehold(db);
const tz = household?.tz ?? config.householdTz;
const at = now();
const local = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at));
const days = getOffsetMs() / 86_400_000;
console.log(`[time-travel] it's now ${local} (${tz}), ${days === 0 ? "real time" : `${days >= 0 ? "+" : ""}${days.toFixed(2)} days from real time`}`);

if (household) {
  const atRisk = db
    .query<Item, [number, string]>("SELECT * FROM items WHERE household_id = ? AND status = 'fresh' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(household.id, new Date(at.getTime() + AT_RISK_MS).toISOString());
  const past = atRisk.filter((i) => isPast(i, at)).length;
  console.log(`[time-travel] ${atRisk.length} item(s) expiring within 48h (${past} already past the USDA date)`);
}
if (household && household.mode === "group" && !household.chat_id) {
  console.log('[time-travel] warning: no household group chat yet, so group reminders have nowhere to go. Message the group first (e.g. "Thyme hi").');
}
console.log(
  hour >= DAILY_HOUR
    ? "[time-travel] a running agent will send today's reminders within 5 seconds (if it hasn't already today)"
    : `[time-travel] reminders go out at ${DAILY_HOUR}:00; try adding a few hours (e.g. +${DAILY_HOUR - hour}h)`,
);
db.close();
