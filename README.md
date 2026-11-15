# Fridge Squad

An iMessage agent for roommates, built on [Claw Messenger](https://www.clawmessenger.com/docs).
Text it in your household group chat or a DM: it splits grocery bills, tracks what's in the fridge
before it spoils, suggests recipes from what's actually there, and keeps a waste ledger.
Built for HackPrinceton (Best Sustainability Hack, Amazon Practical AI Innovation). Plan: [PLAN.md](PLAN.md).

## Setup

```sh
bun install
cp .env.example .env   # then fill in the values (never commit .env)
bun run spike          # Phase 0: check Claw connectivity, groups, and photo attachments
bun run register-phones  # register CLAW_TEST_NUMBERS with Claw
bun run seed           # one household + starting fridge; roommates join from the group chat and Thyme asks their names
bun run seed --demo    # fictional Alex, Sam, Jordan for the terminal chat
bun run chat           # talk to the agent in the terminal (/as <name>, /group, /dm); spends no messages
bun start              # run on Claw Messenger (real iMessage)
bun test
```

Without `GEMINI_API_KEY` (or with `LLM=off`) the agent uses its rule-based fallback.

Shelf life comes from the USDA FSIS FoodKeeper dataset (public domain), stored in `data/foodkeeper.json`
and imported into SQLite on first start.
