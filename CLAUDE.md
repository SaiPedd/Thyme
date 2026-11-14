An iMessage agent (Photon Spectrum) that helps roommates stop wasting food.
Built for HackPrinceton: Sustainability and Photon tracks.

## Core rule
Claude understands and phrases messages. Code owns dates, math, privacy, and decisions.
Never let the LLM output an expiry date or decide who sees what.

## Scope: ONLY these 4 features
1. Inventory by text ("got chicken, spinach" / "used the last of the rice")
2. Spoilage nudges (daily job, one retry with a different recipe, then stop)
3. Waste ledger (dollars lost, pounds saved, CO2 avoided with cited factors)
4. Break mode (text nearby pantries, handle a decline, confirm pickup)
Do not add other features. Ask me first.

## Stack
Bun + TypeScript (one process), Photon Spectrum (iMessage + terminal provider),
Claude API with Zod-validated output, SQLite, Hono, React + Vite (dashboard, optional).

## Conventions
- All time goes through `now()` in `src/clock.ts`. Never call `Date.now()` or `new Date()` directly. This is our fake clock for demos.
- All outgoing messages go through the outbox in `src/outbox.ts` (enforces quiet hours 10 PM to 8 AM and logs delivery).
- Expiry dates come only from the USDA FoodKeeper table. Claude only maps a phrase to a table entry.
- Recipe suggestions must only use ingredients currently in inventory. Validate in code.
- One projection function decides what each person can see. Personal items only appear in that person's own DM.
- Group chats are allowed but shared-only: in a group, the bot handles and replies about shared household items and anonymous totals only. Anything personal is handled in that person's DM.
- If Claude fails or takes more than 8 seconds, fall back to a rule-based parser.
- Secrets live in `.env` (gitignored). Never print or commit keys.

## Workflow
- Work one step at a time from PLAN.md. Propose a plan before editing files.
- Write `bun test` tests for expiry math, projection, quiet hours, and nudge escalation.
- Run the tests before saying a step is done.
- Keep code simple. This is a 36-hour hackathon build.

## Commands
- `bun run index.ts` to start
- `bun test` to run tests
## Photon / Spectrum setup
@AGENTS.md
