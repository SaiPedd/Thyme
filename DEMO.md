# Fridge Squad demo script

About 4 minutes. Rehearse it 3 to 5 times from a fresh seed, and record one clean run as a backup video.

## Before the demo (10 minutes ahead)

1. `bun test`: all tests pass.
2. Pick the mode:
   - **Terminal (safe, no phones):** `bun run seed --demo`, then `bun run chat`.
   - **Live iMessage:** `bun run seed` (no `--demo`), `bun run spike` (Claw connected, photos come through),
     then `bun run start`. Each roommate texts the group once and tells Thyme their name.
3. Open a second terminal in the repo for `bun run time-travel` (step 5).
4. In the terminal, use `~/Desktop/receipt.jpg`. Live, have the same receipt photo on the presenter's phone.

In the terminal, a line starting with `/` is a command for the terminal chat (who you are, sending a photo).
Everything else is a text message. `/as Sam, <message>` switches to Sam and sends the message.

## The script

### 1. Split a grocery receipt (P1)
Say: "Alex just got back from Trader Joe's. Sam paid, and the chicken is just Alex's."

| Type (as Alex, in the group) | Expect |
|---|---|
| `/photo ~/Desktop/receipt.jpg Thyme receipt` | Thyme lists 5 items, tax $0.30, total $23.16. Nothing saved yet. |
| `Sam paid, 2 is mine` | Updated list: "Paid by Sam", chicken marked "(just Alex's)". |
| `yes` | Alex owes Sam $13.79, Jordan owes Sam $4.68. 4 items added to the fridge; paper towels left out (not food). |

Say: "The model reads the receipt. Code checks that the items add up to the total and does every split, to the cent."

### 2. Privacy: balances go to DMs
| Type | Expect |
|---|---|
| `/as Sam, Thyme what do I owe?` | In the group: "sent you a DM". In Sam's DM: owed $18.47. |

Say: "The group sees shared splits. Personal balances, allergies, and personal items only go to that person."

### 3. Cook with what's there (P3)
| Type | Expect |
|---|---|
| `Thyme what can I make tonight?` | A recipe built around what's in the fridge (from TheMealDB), plus anything else you'd need to buy. |

Say: "It starts from what's already in the kitchen, so the food that's about to go bad gets used first."

### 4. Food is about to spoil (P2)
In the second terminal:
```
bun run time-travel +1d10h
```
Within 5 seconds the group gets: "Heads up: the baby spinach expires in 2 days ... Anyone want them?"
Alex gets a private DM that their chicken is past the USDA date.

Say: "Expiry dates come from the USDA FoodKeeper table, using the conservative end. The model never guesses a date."

| Type | Expect |
|---|---|
| `/as Jordan, Thyme I'll take the spinach` | "The baby spinach is yours." The first claim wins; code decides. |

### 5. Waste ledger (P4)
| Type (as Jordan) | Expect |
|---|---|
| `Thyme I tossed the bananas, they went bad` | Logged in the waste ledger (tracking only: it doesn't change anyone's balance). |
| `Thyme how much food have we wasted?` | Items wasted and rescued this week. Dollars only count food with a known price (the starter bananas have none). |

Say: "Every toss and rescue goes in the waste ledger, so the house sees what it's throwing away and what it saved."

| Type | Expect |
|---|---|
| `Thyme where can we donate the rice?` | Arm In Arm at Nassau Presbyterian Church, sealed and unopened only. |
| `Thyme can we donate the spinach?` | Fresh food: offer it to the house first; the mobile pantry only by arrangement. |
| `Thyme I donated the rice` | Off the list, counted as a rescue. |

Say: "Instead of tossing it, Thyme points you to a local pantry, and code checks it's safe to give: sealed, in date, and somewhere that takes that kind of food."

### Close
"One group chat. It splits the bill, warns you before food goes bad, cooks with what's left, and keeps score on waste."

## If something goes wrong live

| Problem | Do this |
|---|---|
| Receipt split is wrong after `yes` | As the sender: `undo`. That removes the expense and its fridge items. Send the photo again. |
| Wrong change before `yes` | Send the right one (`2 is shared`, `Alex paid`), or `cancel` and send the photo again. |
| A line was misread before `yes` | `remove 3` takes it off; `3 was 4.29` fixes its price; `3 was yogurt` names it. |
| "I'm having trouble reading receipts right now" | A Gemini hiccup (seen once in rehearsal; the same photo worked a minute later). Send the photo again. |
| Thyme says "having trouble" | Wait a few seconds and resend. If Gemini is down, the rule-based fallback still handles plain logs, `undo`, and `what do I owe?`. |
| Reminder doesn't show after time travel | Someone has to message the group first. |
| Anything else | Play the backup video. |

## Known rough edges (stay off these paths on stage)

- The `--demo` seed already has baby spinach, bananas, and chicken, so after the receipt there are two of each and the
  reminder lists both.
- You can't reopen a saved receipt to edit it; use `undo` and resend.
- Bread doesn't match a USDA entry yet, so a receipt's bread isn't added to the fridge (Thyme says so).
- A typo in a roommate's name gets "I don't know who that is".
