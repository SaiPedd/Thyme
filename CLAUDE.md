Fridge Squad: an iMessage agent on Claw Messenger for roommates. It splits grocery bills, tracks the
fridge before food spoils, suggests recipes from what's there, and keeps a waste ledger.
Built for HackPrinceton: Best Sustainability Hack and Amazon Practical AI Innovation.
It is a conversational agent, not a notification system. Proactive messages only open a conversation.

## Core rule
The model (Gemini) understands, converses, and chooses wording. Code owns every fact: expiry dates,
money, splits, balances, who wins a claim, and who sees what. The model never outputs a number of days,
a dollar total, or a recipient. It calls tools, and tools return facts.

## Scope: ONLY these, in priority order
P1. Grocery expense splitting (plaintext; receipt photo is a stretch goal that depends on the spike)
P2. Inventory and expiry tracker (USDA FoodKeeper), reminders, claims on expiring shared items
P3. Kitchen companion (open questions, recipes from current inventory, saved preferences)
P4. Waste ledger (tosses and rescues; tracked, never charged to balances, so nobody pays twice for a split item)
Cut: dinner plans, break mode, weekly digest, dashboard, full onboarding. One seeded household; roommates join
from the household group chat, and the agent (named by BOT_NAME, default Thyme, plus BOT_ALIASES) asks their names once.
Do not add other features. Ask me first.

## Stack
Bun + TypeScript (one process), bun:sqlite, Bun's built-in WebSocket, Gemini Interactions API via
`@google/genai` (function calling, stateless `store: false`; model from GEMINI_MODEL, default
`gemini-3.5-flash-lite`), Zod for structured output (receipts).
Channel: Claw Messenger (https://www.clawmessenger.com/docs) behind one adapter interface:
`claw` (WebSocket, groups and DMs) and `terminal` (dev only, plain stdin/stdout, spends no messages).

## Conventions
- All time goes through `now()` in `src/clock.ts`. Never call `Date.now()` or `new Date()` directly. This is our fake clock for demos.
- All outgoing messages go through `src/outbox.ts`: quiet hours 10 PM to 8 AM (household tz) for proactive sends,
  daily caps, per-send result tracking, retry on retryable errors, honor 429 Retry-After, a local usage
  counter, and refusing proactive sends above 90% of the monthly budget. `ok:true` means accepted, never delivered.
- Every outbound message declares an audience (`group` or `member`) and passes through
  `src/privacy/projection.ts`. The group gets shared items, shared splits, and household totals only.
  Personal items, allergies, balances, and ledger details go to that person's DM. Never name who has an allergy in a group.
- In groups, reply only when addressed by BOT_NAME, replied to, asked a direct question, or for a clear
  food or expense log. Otherwise stay silent and record context. Use tapbacks for routine acknowledgments.
  Ignore group messages from numbers that aren't household members.
- HOUSEHOLD_MODE=group|dm. In dm mode, group-audience messages fan out to each member's DM.
- Expiry dates come only from the USDA FoodKeeper table. The model only maps a phrase to a table entry.
  `expires_at` uses the conservative low end. Ask raw or cooked when ambiguous.
- Money is integer cents. Split shares always sum exactly to the total; leftover cents go to the buyer.
- Item prices come only from what a roommate said they paid (or a receipt). Never estimate a price; unknown stays NULL.
- Recipe suggestions must only use ingredients currently in inventory. Validate in code.
- Food safety answers are conservative. If unsure, say to toss. Never claim a dish is safe for an allergy.
- The agent loop runs at most 6 tool iterations with a 10 second timeout. On failure or LLM=off, use the rule-based fallback.
- Receipt images: download in the handler, then discard the bytes after parsing. Never store card digits.
  Require confirmation before committing.
- Reliability: dedupe by messageId, serialize per chat, debounce 2s per sender, send `sync` on reconnect.
- Never log message text, full phone numbers (mask to the last 4), the API key, the WebSocket URL, or receipt image URLs.
- Secrets live in `.env` (gitignored): CLAW_API_KEY, GEMINI_API_KEY. Never print or commit them,
  and never ask the user to paste them into chat. If a key or file is needed, say what to put in `.env` and stop.

## Workflow
- Work phase by phase from PLAN.md. Propose a plan before editing files.
- Commit after each phase. Run `bun test` before saying a phase is done, then say exactly what to test from a phone.
- Tests cover: split math invariants, the conservative expiry rule, projection (the group never leaks personal data),
  claim arbitration, quiet hours and caps, undo, duplicate expenses, the receipt sum check, and a 3-day fake-clock scenario.
- Keep code simple. This is a ~4-hour build with 3 people working in parallel.

## Commands
- `bun run start`: run the agent. `bun test`: tests.
- `bun run chat`: terminal adapter. `bun run seed`: one household, 3 members, starting inventory.
- `bun run time-travel +1d`: advance the clock and tick the scheduler. `bun run spike`: Claw connectivity spike.
- `bun run register-phones`, `bun run load-foodkeeper`, `bun run eval`.
