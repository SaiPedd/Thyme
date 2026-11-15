# Meet Thyme

**Thyme** is an iMessage agent for roommates. Add it to your household group chat (or text it directly)
and it splits grocery bills, keeps track of what's in the fridge before it spoils, answers kitchen
questions, and helps the house waste less food. No app to install: it lives in the normal Messages app.

Built at HackPrinceton for **Best Sustainability Hack** and **Amazon Practical AI Innovation**.
Full build plan: [PLAN.md](PLAN.md).

## Status

| Phase | What | State |
|---|---|---|
| 0 | Claw Messenger spike, config, database schema, USDA FoodKeeper import | Done |
| 1 | Bun WebSocket integration, Gemini Interactions loop, privacy and outbox | Done |
| 2 | Expense splitting: split summary, recording expenses, undo, balances | Done |
| 3 | Inventory and expiry tracking, reminders, claims on expiring food | Done |
| 4 | Kitchen companion: recipes from what's in the fridge, saved preferences | Done |
| 5 | Waste ledger: tosses and rescues, shared waste in the same balances | Done |
| 6 | Receipt photos (stretch) | Next |
| 7 | Demo polish, eval script | Planned |

## What works today

In the household group chat:

```
Thyme:  Hi, I'm Thyme! I help this house split groceries, keep track of what's in the fridge,
        and waste less food.
        First, what should I call each of you? Reply "I'm <your name>".
        To get my attention, just say "Thyme".
Alex:   I'm Alex
Thyme:  Nice to meet you, Alex! Still waiting on: Roommate 0102.
Alex:   hey Thyme, groceries were $48.60, split 3 ways, chicken thighs ($9) are just mine
Thyme:  Got it! Recorded $48.60 for groceries. Sam and Jordan each owe you $13.20.
        Reply "undo" if anything needs fixing.
Sam:    what do I owe?
Thyme:  I sent your balance to you privately.          (amounts go to Sam's DM only)
```

In a DM:

```
Sam:    how long does cooked rice last in the fridge?
Thyme:  Cooked rice lasts 4-6 days in the fridge according to the USDA FoodKeeper!
```

- **Expense splitting:** equal, per item ("the chicken is just mine"), between some roommates ("the milk
  is me and Sam"), or fixed amounts ("Sam owes 8"). Also undo, duplicate detection, and balances
  that net out across everything.
- **Roommates and names:** whoever is in the household group becomes a roommate. Thyme asks each person
  their name once and welcomes anyone added later.
- **Getting its attention:** say "Thyme" (or an alias from `BOT_ALIASES`) anywhere in a message. In the group
  it also answers questions and clear food or expense logs. Other chatter is kept as context, and Thyme stays quiet.
- **Shelf life:** answers come from the USDA FoodKeeper table (661 foods), never from the model's memory.
- **Fridge tracking:** "got spinach and milk" logs food with a USDA expiry date. Thyme reminds the group at
  9 AM about shared food expiring within 48 hours (personal food goes to the owner's DM), and "mine" claims it.
- **Kitchen companion:** "what can I make?" suggests a recipe that only uses what's in the fridge, favoring food
  about to expire and honoring saved diets, dislikes, and allergies.
- **Waste ledger:** "tossed the spinach" splits a shared item's cost into the same balances as groceries
  (unless that day's groceries were already split). Eating something before it expires counts as a rescue.
  "How much have we wasted?" shows dollars, pounds, and CO2; the group sees household totals only.
  "undo" reverses the last expense or toss.

## How it works

```
iMessage ── Claw Messenger ── WebSocket ──► inbox ──► router ──► agent (Gemini) ──► tools ──► SQLite
                                           (dedupe,   (members,   (function calls,    (splits,
                                            debounce)  triggers)   10 s deadline)      balances,
                                                                                       shelf life)
                                                          │
                          outbox ◄── privacy projection ◄─┘
             (quiet hours, caps, retries)  (group vs DM)
```

Design rules:

- **Code owns every fact.** Gemini picks which tool to call and how to phrase the reply. Dollar amounts,
  shares, balances, and shelf-life days all come from code. A reply that states an amount or a
  duration that no tool returned is rejected and replaced with the tool's own wording.
- **Privacy by construction.** Every outgoing message declares who it's for and whether it's personal.
  A single projection function enforces this: the group only ever gets shared items, shared splits,
  and household totals. Balances and anything personal go to that person's DM.
- **Never stuck.** If Gemini is off, slow (over 10 s), or fails, a rule-based parser handles the core
  messages ("groceries $30 split 3 ways", "undo", "what do I owe"). If a tool already ran, Thyme
  reports that result instead of running the action twice.
- **Polite in a group.** Proactive messages respect quiet hours (10 PM to 8 AM), daily caps, and a
  monthly message budget. Replies to someone who just texted always go out right away.
- **Money in integer cents.** Shares always add up exactly to the total. Leftover cents go to the person
  who paid. This is checked by a 2,000-case property test.

## Setup

You need [Bun](https://bun.sh), a [Claw Messenger](https://www.clawmessenger.com) account (Growth plan,
which allows up to 5 registered phone numbers), and a Gemini API key.

```sh
bun install
cp .env.example .env    # fill in the values; never commit .env
```

| Variable | What it's for |
|---|---|
| `CLAW_API_KEY` | Claw Messenger API key (`cm_live_...`) |
| `GEMINI_API_KEY` | Gemini API key |
| `GEMINI_MODEL` | Defaults to `gemini-3.5-flash-lite` |
| `BOT_NAME` / `BOT_ALIASES` | The agent's name (default `Thyme`) and other names it answers to |
| `HOUSEHOLD_MODE` | `group` (household lives in a group chat) or `dm` (group messages go to each roommate's DM) |
| `HOUSEHOLD_TZ` | Time zone for quiet hours and reminders, e.g. `America/New_York` |
| `LLM` | `off` to use only the rule-based fallback |
| `CLAW_TEST_NUMBERS` | Phones for the spike and phone registration, in `+1...` format |

Secrets stay in `.env`. The startup check reports only whether each key is set, never its value.
Logs never contain message text or full phone numbers (only the last 4 digits).

## Commands

```sh
bun run spike            # check Claw connectivity, group chats, and photo attachments
bun run register-phones  # register CLAW_TEST_NUMBERS with Claw
bun run seed             # one household + a starting fridge; roommates join from the group chat
bun run seed --demo      # fictional roommates (Alex, Sam, Jordan) for the terminal chat
bun run chat             # talk to Thyme in the terminal (/as <name>, /group, /dm); sends no real messages
bun start                # run Thyme on Claw Messenger (real iMessage)
bun test                 # 134 tests
bun run typecheck
```

To try it without phones, run `bun run seed --demo` and then `bun run chat`.

## Project layout

```
index.ts                 entry point (Claw or terminal adapter)
src/adapters/            claw.ts (WebSocket), terminal.ts (dev), types.ts (one interface for both)
src/agent/               loop.ts (Gemini function calling), tools.ts, prompt.ts, fallback.ts, triggers.ts
src/domain/              money, splits, expenses, household, foodkeeper, phone, inventory, claims,
                         recipes, prefs, prices, waste (ledger), impact (pounds and CO2)
src/privacy/projection.ts  who can see what
src/inbox.ts             dedupe, debounce, per-chat ordering
src/outbox.ts            quiet hours, caps, budget, retries, delivery tracking
src/router.ts            members, group rules, names, replies
src/db/                  SQLite schema and migrations
src/clock.ts             the only source of time (fake clock for demos)
src/scheduler.ts         9 AM expiry reminders (one retry), clock offset for time travel
scripts/                 spike, register-phones, seed, load-foodkeeper, time-travel
test/                    bun test suites
data/foodkeeper.json     USDA FoodKeeper data
```

## Data sources

- **Shelf life:** [USDA FSIS FoodKeeper](https://catalog.data.gov/dataset/fsis-foodkeeper-data) (public domain).
  Imported into SQLite on first start. Expiry uses the conservative low end of each range. Foods where
  USDA gives guidance instead of a number (milk: "Package use-by date") keep that guidance.
- **CO2 of wasted food:** category averages of kg CO2e per kg from Poore & Nemecek (2018), *Science*
  360(6392), via [Our World in Data](https://ourworldindata.org/food-choice-vs-eating-local). Weights per
  item are typical package sizes. Both are estimates, and Thyme says so.
- **Price estimates:** `data/prices.json`, rough US grocery prices used until someone gives the real price.

## Known limitations

- Receipt photos arrive but aren't read yet (Phase 6).
- Waste costs use the price someone gave, or an estimate from `data/prices.json` when they didn't.
- Pounds and CO2 are per-category estimates, not weighed amounts.
- Group chats need both roommates' numbers registered with Claw first (`bun run register-phones`).
- Thyme is also a herb, so "we're out of thyme" will get a reply.
