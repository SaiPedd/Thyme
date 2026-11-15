// Fridge Squad entry point.
//   bun run start   -> Claw Messenger (real iMessage)
//   bun run chat    -> terminal adapter (dev, spends no messages)

import { ClawAdapter } from "./src/adapters/claw";
import { TerminalAdapter } from "./src/adapters/terminal";
import type { Adapter } from "./src/adapters/types";
import { makeClient } from "./src/agent/loop";
import { loadConfig, printPreflight } from "./src/config";
import { openDb } from "./src/db";
import { ensureShelfLife } from "./src/domain/foodkeeper";
import { makeMealDbClient } from "./src/domain/mealdb";
import { getHousehold, getMembers } from "./src/domain/household";
import { Inbox } from "./src/inbox";
import { Outbox } from "./src/outbox";
import { makeRouter } from "./src/router";
import { Scheduler, syncClockFromDb } from "./src/scheduler";

const useTerminal = process.argv.includes("--terminal") || process.env.ADAPTER === "terminal";
const loaded = loadConfig(process.env, { requireClaw: !useTerminal });
if (!printPreflight(loaded)) process.exit(1);
const { config } = loaded;

const db = openDb(config.dbPath);
await ensureShelfLife(db);
syncClockFromDb(db); // honor `bun run time-travel`
const household = getHousehold(db);
if (!household) {
  console.error("[start] no household yet: run `bun run seed` first");
  process.exit(1);
}
const members = getMembers(db, household.id);
if (useTerminal && members.length === 0) {
  console.error("[start] the terminal chat needs roommates: run `bun run seed --demo` (or set SEED_MEMBERS)");
  process.exit(1);
}

const inboxRef: { current?: Inbox } = {};
// In terminal mode, use the real group chat id if one is known, else a stand-in that is never saved.
const devGroupChatId = useTerminal ? (household.chat_id ?? "terminal-group") : undefined;
const adapter: Adapter = useTerminal
  ? new TerminalAdapter(members.map((m) => ({ name: m.name, phone: m.phone })), devGroupChatId!, config.botName)
  : new ClawAdapter({ apiKey: config.clawApiKey!, lastSeenAt: () => inboxRef.current?.lastSeenAt() ?? null });

const outbox = new Outbox(db, adapter, { devGroupChatId });
const router = makeRouter({
  db,
  outbox,
  adapter,
  botName: config.botName,
  botAliases: config.botAliases,
  model: config.geminiModel,
  client: makeClient({ llm: config.llm, apiKey: config.geminiApiKey }),
  mealdb: config.mealdb ? makeMealDbClient(config.mealdbApiKey) : null,
  devGroupChatId,
});
const inbox = new Inbox(db, router, {
  debounceMs: useTerminal ? 300 : 2000,
  onAccepted: () => {
    if (!useTerminal) outbox.recordInbound();
  },
  log: (l) => console.log(l),
});
inboxRef.current = inbox;

await adapter.start({ onMessage: (m) => inbox.push(m), onStatus: (s) => outbox.markStatus(s) });
console.log(
  `[start] ${adapter.name} adapter, household "${household.name}" (${members.length} members, ${household.mode} mode), agent ${
    config.llm && config.geminiApiKey ? config.geminiModel : "fallback rules"
  }`,
);

// Scheduler: deferred sends, and the 09:00 expiry reminders. Re-reads the demo clock each tick,
// so `bun run time-travel +2d` in another terminal takes effect within a few seconds.
const scheduler = new Scheduler(db, outbox, { groupChatId: devGroupChatId });
const tick = () => {
  syncClockFromDb(db);
  scheduler.tick().catch((e) => console.error(`[scheduler] tick failed: ${(e as Error).name}`));
};
tick();
const flusher = setInterval(tick, 5_000);

process.on("SIGINT", async () => {
  clearInterval(flusher);
  await inbox.drain();
  await adapter.stop();
  db.close();
  process.exit(0);
});
