## One-liner
An iMessage agent that knows what's in your roommates' fridge and texts you before food goes bad.

## The 4 features
1. **Inventory by text:** "got chicken, spinach, rice" / "used the last of the rice". Claude extracts items, code looks up shelf life from USDA FoodKeeper and sets expiry. Items are personal or shared.
2. **Spoilage nudges:** daily job finds items expiring within 48 hours, texts the owner a recipe built only from current inventory. No reply by next morning: one retry with a different recipe, then stop.
3. **Waste ledger:** logs tossed items, shows dollars lost, pounds saved, CO2 avoided (cited per-category factors). Household sees an anonymous total, owners get a private note.
4. **Break mode:** before a holiday, list leftovers, find nearby pantries with Google Places, text them, handle a decline by moving to the next, confirm pickup time.

## Build steps
1. Hello world on Spectrum: bot echoes a text from the terminal provider, then iMessage.
2. Schema and data: SQLite tables (households, members, items, events, nudges, jobs), load FoodKeeper into a shelf_life table, write `now()` fake clock in src/clock.ts.
3. Onboarding: one text creates a household and invites roommates, each in their own DM thread.
4. Feature 1: Zod schema {intent, items[], askingAbout, reply}, Claude prompt tested on ~20 messy messages, code maps items to FoodKeeper, rule-based fallback parser.
5. Feature 2: scheduler polls jobs table each minute using now(), nudge job, recipe validation, one escalation, outbox with quiet hours in src/outbox.ts.
6. Feature 3: toss events with cost and weight, CO2 factors, monthly summary text.
7. Feature 4: break mode with Places search (cached), pantry reply parsing, decline then next, confirm pickup. Play the pantry from a second simulated number in the demo.
8. Privacy pass and tests: one projection function, bun test for expiry math, projection, quiet hours, escalation.
9. Dashboard (optional): Hono JSON endpoint plus one React page with fridge timeline and ledger.
10. Demo and submission: seed script, rehearse the 3-minute flow twice, backup video, README, Devpost.

## Demo (3 min)
1. Roommates text groceries in messy language.
2. Fake clock skips two days, spinach nudge fires.
3. One roommate declines, agent retries with a new recipe.
4. Skip to break, agent texts a pantry and confirms pickup.
5. Ledger shows the savings.

## Checkpoints
- Saturday 6 PM: steps 1 to 5 working. If not, script break mode as a scene.
- Saturday midnight: steps 1 to 7 working.
- Sunday 10 AM: feature freeze, bug fixes only.