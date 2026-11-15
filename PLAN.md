# Fridge Squad: plan

## One-liner
Roommates text one agent, in their household group chat or in DMs, using the normal Messages app.
It splits grocery bills, tracks what's in the fridge before it spoils, answers kitchen questions with
recipes from what's actually there, and keeps a waste ledger in the same balances as the groceries.
It is a conversational agent, not a notification system: proactive messages only open a conversation.

Tracks: Best Sustainability Hack; Amazon Practical AI Innovation (creativity, usefulness,
technical implementation, UX, 25% each).

## Priorities (build in this order)
- P1. Grocery expense splitting: (a) plaintext; (b) receipt photo, a stretch goal that depends on the spike.
- P2. Inventory and expiry tracker (USDA FoodKeeper), reminders, claims on expiring shared items.
- P3. Kitchen companion: open questions, recipes from current inventory, saved preferences.
- P4. Waste ledger: tosses and rescues. Shared waste goes into the same balance table as grocery splits.

Cut entirely: dinner plans, break mode, weekly digest, dashboard, full onboarding flow. One seeded household;
roommates are added from the group chat and Thyme asks each one's name once (added after Phase 1 review).

## Phases
Each phase leaves a working demo. Time boxes assume a 4-hour build (T = time since start).
A = channel owner, B = agent owner, C = domain/data owner.

### Phase 0: spike and cleanup (T+0:00 to 0:40)
- A: scripts/spike.ts connects to Claw, checks readiness, creates a group with CLAW_TEST_NUMBERS,
  sends a photo, and logs metadata only: type, masked from, chatId, isGroup, participant count,
  attachment count, and mime type. It also confirms attachments[0].url can be downloaded.
  The report decides HOUSEHOLD_MODE (group or dm) and whether receipt photos are in scope.
- B: remove the old messaging dependency (package, docs, AGENTS.md, skills); src/config.ts with a
  preflight report that never prints secrets; .env.example with names only.
- C: src/db/ schema and migrations (see Schema); move phone helpers to domain/phone.ts;
  FoodKeeper loader writes into the new schema plus FTS5.
- Done when: the spike report is posted, `bun run start` prints a preflight report, and tests pass.
- Test: `bun run spike` and `bun test`

### Phase 1: channel, agent skeleton, money core (T+0:40 to 1:30), all three in parallel
**Status: DONE.** Integrated the Bun WebSocket (Claw adapter, inbox, outbox, privacy projection) and
developed the Gemini Interactions loop (gemini-3.5-flash-lite, function calling, rule-based fallback).
- A: adapters/types.ts, claw.ts (Bun WebSocket, 30s ping/pong, 300s idle, backoff capped at 30s,
  sync on reconnect, dedupe via seen_messages, per-chat serialization, 2s debounce), terminal.ts;
  outbox.ts; privacy/projection.ts; scripts/chat.ts.
- B: agent/loop.ts (Gemini Interactions function-calling loop: max 6 iterations, 10s timeout), prompt.ts, tools.ts
  (stubs wired to domain), fallback.ts (rules for "got X, Y", "used the X", "tossed X",
  "groceries $N split K ways", "undo").
- C: domain/money.ts and splits.ts (integer cents; equal, per-item, subset and custom modes;
  leftover cents go to the buyer), duplicate hash, undo; scripts/seed.ts.
- Done when: in `bun run chat`, a message reaches the agent and a reply comes back through outbox
  and projection; split math tests pass.
- Test: `bun test` and `bun run chat`

### Phase 2: P1a expense splitting end to end (T+1:30 to 2:00), first demo-able feature
**Status: DONE.** Split summary posted to the group (explicit who-owes-whom), expenses recorded with
integer-cent splits, duplicate detection, undo, and balances sent privately by DM.
- record_expense, undo_last and get_balances tools; the reply always shows the computed result
  and how to fix it.
- Group: the split summary goes to the group; each person's balance goes to their own DM.
- Done when: "groceries were $48.60, split 3 ways, chicken thighs ($9) are just mine" gives exact
  shares that sum to the total, and "undo" reverses it, over the terminal and from a phone.
- Test: `bun test` and `bun run chat`

### Phase 3: P2 inventory, expiry, reminders, claims (T+1:30 to 2:30), B and C in parallel with Phase 2
**Status: DONE.** add_item, use_item, log_toss, get_inventory, claim_item (agent + fallback rules);
src/scheduler.ts (09:00 reminders, one retry, via the outbox); claims by sentAt (an earlier claim that
arrives late takes over and the group is told); `time-travel` saves the clock offset in the state
table so a running agent follows it within 5 s; data/prices.json. log_toss only marks the item;
the ledger row and balances are Phase 5.
- shelf_life_lookup (top 5 matches via FTS5). The model picks an id; code computes expires_at (low end).
  Ask raw or cooked when ambiguous.
- add_item, use_item, log_toss, get_inventory; data/prices.json (~60 items) for estimates,
  overridden by receipts or the user.
- scheduler.ts: a daily 09:00 job (HOUSEHOLD_TZ) finds items expiring within 48h. Shared items
  go to the group, personal items to the owner's DM. One retry the next morning, then stop.
  Everything goes through the outbox.
- Claims: "mine" or "I'll take it" on an expiring shared item. The first valid claim by sentAt wins
  (receive time if sentAt is missing); the loser is told who won.
- Done when: after `bun run seed`, `bun run time-travel +2d` fires the reminders described above,
  and two claims resolve correctly.
- Test: `bun test` and `bun run time-travel +2d`

### Phase 4: P3 kitchen companion (T+2:00 to 2:45)
- Tools: suggest_recipe, save_preference, get_preferences, get_household_summary.
- Recipes use only current inventory (plus salt and oil). Code checks every ingredient and flags
  what's missing, honoring dislikes and diets. "I cooked it" updates the inventory after confirmation.
- Food safety answers are conservative: ask raw or cooked; if unsure, say to toss; never claim
  a dish is safe for an allergy.
- Capped per-chat history (turns); per-person preferences; "forget me" deletes that person's
  prefs and turns.
- Done when: "what can I make tonight?" returns a recipe whose ingredients are all in inventory,
  and saved dislikes are respected.
- Test: `bun test` and `bun run chat`

### Phase 5: P4 waste ledger and combined balances (T+2:30 to 3:15)
- log_toss writes a ledger row. A personal toss costs the owner. A shared toss is split equally,
  and each non-buyer owes the buyer their share. An at-risk item (within 48h) eaten = rescued.
- Same balance_entries table as expenses. "what do I owe?" returns one number plus a breakdown, in DM.
- CO2 from a hardcoded per-category factor, with the source cited in code and the README.
- The group sees household totals only.
- Done when: tossing a shared item changes everyone's balance correctly, and the group only sees totals.
- Test: `bun test`

### Phase 6: P1b receipt photo (T+3:00 to 3:30), stretch; only if the spike shows attachments work
- Download inside the handler immediately (never log the URL), send to Gemini (image input), and validate
  the result with a Zod schema (items, prices, tax, discounts, total, store, date).
- Code checks items + tax - discounts = total within 1 cent; otherwise it flags the mismatch.
  Tax is allocated in proportion to item subtotals.
- Show the parsed list and require confirmation before saving. Ask about unreadable lines.
  Items go to inventory via shelf_life_lookup with their real prices. Discard image bytes;
  never store card digits.
- Done when: a real receipt photo produces a confirmed, balanced expense plus inventory items.
- Test: `bun test`, then a photo sent from a phone

### Phase 7: demo polish (T+3:15 to 4:00)
- scripts/eval.ts (~25 logging and 10 expense messages, prints the pass rate); README
  (setup, CO2 source); rehearse the demo twice; record a backup video.
- Done when: the eval pass rate is reported and the demo has been run twice cleanly.
- Test: `bun run eval` and `bun test`

## Parallelization map (3 people)
| Time | A: channel | B: agent | C: domain/data |
|---|---|---|---|
| 0:00–0:40 | spike.ts | dependency removal, config/preflight | schema, FoodKeeper, phone helpers |
| 0:40–1:30 | claw/terminal adapters, outbox, projection, chat | agent loop, prompt, fallback | money/splits, undo, dedupe, seed |
| 1:30–2:00 | wire expense flow into adapters | record_expense/undo/balances tools | shelf_life_lookup, prices.json |
| 2:00–2:45 | scheduler + time-travel | kitchen companion tools, prefs, recipe check | inventory tools, claims |
| 2:30–3:15 | group reply rules, tapbacks | eval.ts | waste ledger, balances, CO2 |
| 3:00–3:30 | receipt download (stretch) | vision + Zod (stretch) | receipt sum check, tax allocation |
| 3:15–4:00 | demo run | README | tests for the 3-day scenario |

Agree on these interfaces at T+0:40: the adapter types, the tool signatures, and the schema.

## Schema (bun:sqlite; all times are ISO strings from now(); money in integer cents)
- households(id, name, chat_id UNIQUE NULL, tz, mode CHECK(group|dm), created_at)
- members(id, household_id, phone UNIQUE (+E.164), name, created_at)
- shelf_life(id, category, name, subtitle, keywords, pantry/fridge/freezer _min_days/_max_days,
  pantry/fridge/freezer _note) plus shelf_life_fts FTS5(name, subtitle, keywords)
- items(id, household_id, name, shelf_life_id, storage CHECK(pantry|fridge|freezer),
  owner_member_id NULL=shared, buyer_member_id, qty, unit, cost_cents, cost_source
  CHECK(receipt|user|estimate), added_at, expires_at NULL, status CHECK(fresh|used|tossed), status_at)
- expenses(id, household_id, buyer_member_id, total_cents, mode CHECK(equal|per_item|subset|custom),
  description, source CHECK(text|receipt), dedupe_hash UNIQUE, source_message_id, created_at, undone_at)
- expense_shares(id, expense_id, member_id, share_cents)  (sum = total, checked in code and tests)
- ledger(id, household_id, item_id, member_id, kind CHECK(rescued|wasted), cost_cents, shared,
  buyer_member_id, at)
- balance_entries(id, household_id, debtor_member_id, creditor_member_id, amount_cents,
  source CHECK(expense|waste), source_id, created_at, undone_at)  (the one combined balance table)
- claims(id, item_id, member_id, message_id, claimed_at, won, created_at); one winner per item
  (partial unique index WHERE won = 1)
- prefs(id, member_id, kind CHECK(diet|dislike|allergy|like), value, created_at, UNIQUE(member_id, kind, value))
- nudges(id, item_id, audience CHECK(group|member), member_id NULL, attempt CHECK(1|2), send_id,
  sent_at, responded_at, UNIQUE(item_id, attempt))
- seen_messages(message_id PRIMARY KEY, chat_id, received_at)
- turns(id, chat_id, member_id NULL, role CHECK(user|assistant|tool), content, created_at)  (capped per chat)
- usage_counters(month PRIMARY KEY 'YYYY-MM', inbound, outbound, proactive)
- sends(id PRIMARY KEY, audience, chat_id NULL, to_phone NULL, kind CHECK(reply|proactive),
  status CHECK(queued|deferred|accepted|delivered|read|failed), message_id, attempts,
  not_before, last_error, created_at)  (outbox per-send tracking)
- state(key PRIMARY KEY, value)  (for example last_seen_at, used by sync after a reconnect)

The old events and jobs tables are dropped; the scheduler derives work from items and nudges.

## Cut list (cut from the top first if we fall behind)
1. P1b receipt photo
2. scripts/eval.ts
3. "I cooked it" walkthrough updating inventory
4. Claims arbitration (fall back to "first reply wins", no loser message)
5. CO2 figure (keep dollars and pounds)
6. 2s debounce and tapback acknowledgments (reply normally)
7. HOUSEHOLD_MODE=dm fan-out (if the spike shows groups work)

Never cut: integer-cent split math, conservative expiry, the privacy projection, quiet hours, caps.

## Demo (3 min)
1. The group texts "groceries were $48.60, split 3 ways, chicken thighs ($9) are just mine".
   The split posts to the group, and each balance goes to that person's DM.
2. Talk-to-log: "got spinach and milk", "tossed the leftover rice".
3. `time-travel +2d`: the spinach reminder opens a conversation in the group, and a roommate claims it.
4. "what can I make tonight?" returns a recipe using only fridge items.
5. "what do I owe?" in DM shows one number that includes shared waste; the group sees household totals.
