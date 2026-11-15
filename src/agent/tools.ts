// Agent tools. The model decides WHICH tool to call and with what words; code computes every fact
// (money, splits, balances, shelf life) and returns it. Personal facts requested in a group are
// not returned to Claude at all: they are queued as a DM to that member instead.

import type { Database } from "bun:sqlite";
import { formatCents, parseCents } from "../domain/money";
import { balancesFor, DuplicateExpenseError, recordExpense, undoLastExpense } from "../domain/expenses";
import { searchShelfLife, type ShelfLifeRow, type Storage } from "../domain/foodkeeper";
import { claimItem, claimTime, claimWinner } from "../domain/claims";
import {
  addItem,
  expiryPhrase,
  findItem,
  isAtRisk,
  isPast,
  itemNote,
  matchItem,
  setItemStatus,
  visibleItems,
  type Item,
} from "../domain/inventory";
import { memberByName, type Household, type Member } from "../domain/household";
import { SplitError, type SplitSpec } from "../domain/splits";
import type { Draft } from "../privacy/projection";

export interface ToolContext {
  db: Database;
  household: Household;
  members: Member[];
  /** The member who sent the message. */
  member: Member;
  isGroup: boolean;
  messageId?: string;
  /** When the sender sent the message (channel time), for claim arbitration. */
  sentAt?: string;
  /** Extra messages to send after the reply (e.g. a private balance DM). */
  drafts: Draft[];
}

export type ToolResult = Record<string, unknown>;

/** A JSON-schema object (OpenAPI subset accepted by Gemini function declarations). */
type JsonSchema = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
  run: (input: any, ctx: ToolContext) => ToolResult;
}

/** Gemini Interactions function tool. */
export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
}

const nameOf = (ctx: ToolContext, id: number) => ctx.members.find((m) => m.id === id)?.name ?? `member ${id}`;

/** Resolve "me", "mine", "I", or a first name to a member id. */
function resolveMember(ctx: ToolContext, who: string): number | null {
  const w = who.trim().toLowerCase();
  if (["me", "mine", "i", "myself", "my"].includes(w)) return ctx.member.id;
  return memberByName(ctx.members, w)?.id ?? null;
}

function resolveMany(ctx: ToolContext, names: string[] | undefined, fallback: number[]): number[] | { error: string } {
  if (!names || names.length === 0) return fallback;
  const ids: number[] = [];
  for (const n of names) {
    if (["everyone", "all", "us", "house"].includes(n.trim().toLowerCase())) return ctx.members.map((m) => m.id);
    const id = resolveMember(ctx, n);
    if (id === null) return { error: `unknown person "${n}". Household members: ${ctx.members.map((m) => m.name).join(", ")}` };
    ids.push(id);
  }
  return ids;
}

const recordExpenseTool: ToolDef = {
  name: "record_expense",
  description:
    "Record a grocery or household expense and split it. Use when someone says what they spent. " +
    "Pass amounts exactly as the user wrote them (e.g. \"$48.60\"). Code computes every share; never compute shares yourself. " +
    "If the user says some items are just theirs or just some people's, list those as items. If someone owes a fixed amount, use fixed.",
  input_schema: {
    type: "object",
    properties: {
      total: { type: "string", description: "Total paid, as written, e.g. \"$48.60\"" },
      buyer: { type: "string", description: "Who paid: \"me\" (default) or a first name" },
      split_among: { type: "array", items: { type: "string" }, description: "Names sharing the remainder. Omit for the whole household." },
      items: {
        type: "array",
        description: "Items not shared by everyone",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            amount: { type: "string", description: "As written, e.g. \"$9\"" },
            members: { type: "array", items: { type: "string" }, description: "Who it's for: \"me\" or names" },
          },
          required: ["description", "amount", "members"],
          additionalProperties: false,
        },
      },
      fixed: {
        type: "array",
        description: "People who owe a fixed amount, e.g. Sam owes 8",
        items: {
          type: "object",
          properties: { member: { type: "string" }, amount: { type: "string" } },
          required: ["member", "amount"],
          additionalProperties: false,
        },
      },
      description: { type: "string", description: "Short label, e.g. \"groceries\"" },
      confirm_duplicate: { type: "boolean", description: "Only true if the user confirmed this is a second, separate purchase" },
    },
    required: ["total"],
    additionalProperties: false,
  },
  run(input, ctx) {
    const total = parseCents(String(input.total));
    if (!total) return { error: "couldn't read the total amount. Ask the user for it." };
    const buyerId = input.buyer ? resolveMember(ctx, String(input.buyer)) : ctx.member.id;
    if (buyerId === null) return { error: `unknown buyer "${input.buyer}"` };
    const among = resolveMany(ctx, input.split_among, ctx.members.map((m) => m.id));
    if ("error" in among) return among;

    const allocations: NonNullable<SplitSpec["allocations"]> = [];
    for (const item of (input.items ?? []) as { description: string; amount: string; members: string[] }[]) {
      const cents = parseCents(item.amount);
      if (cents === null) return { error: `couldn't read the amount for ${item.description}` };
      const ids = resolveMany(ctx, item.members, [ctx.member.id]);
      if ("error" in ids) return ids;
      allocations.push({ amountCents: cents, memberIds: ids });
    }
    const fixed: NonNullable<SplitSpec["fixed"]> = [];
    for (const f of (input.fixed ?? []) as { member: string; amount: string }[]) {
      const id = resolveMember(ctx, f.member);
      const cents = parseCents(f.amount);
      if (id === null || cents === null) return { error: `couldn't read the fixed amount for ${f.member}` };
      fixed.push({ memberId: id, amountCents: cents });
    }
    const memberIds = [...new Set([...among, buyerId, ...allocations.flatMap((a) => a.memberIds), ...fixed.map((f) => f.memberId)])];

    try {
      const e = recordExpense(ctx.db, {
        householdId: ctx.household.id,
        tz: ctx.household.tz,
        spec: { totalCents: total, buyerId, memberIds, allocations, fixed },
        description: input.description,
        sourceMessageId: ctx.messageId,
        allowDuplicate: input.confirm_duplicate === true,
      });
      const payer = nameOf(ctx, e.buyerId);
      const payerShare = e.shares.find((s) => s.memberId === e.buyerId)?.cents ?? 0;
      return {
        recorded: true,
        expense_id: e.id,
        total: formatCents(e.totalCents),
        paid_by: payer,
        split: e.mode,
        shares: e.shares.filter((s) => s.cents > 0).map((s) => ({ name: nameOf(ctx, s.memberId), amount: formatCents(s.cents) })),
        // Spelled out so the wording can't flip who owes whom.
        who_owes_whom: e.shares
          .filter((s) => s.memberId !== e.buyerId && s.cents > 0)
          .map((s) => `${nameOf(ctx, s.memberId)} owes ${payer} ${formatCents(s.cents)}`),
        payer_own_share: `${payer}'s own share is ${formatCents(payerShare)} (already paid)`,
        how_to_fix: "Reply \"undo\" to remove it, then send the corrected message.",
      };
    } catch (error) {
      if (error instanceof DuplicateExpenseError) {
        return { recorded: false, duplicate: true, note: "Same buyer and total already logged today. Ask whether it's a second purchase; if yes, call again with confirm_duplicate." };
      }
      if (error instanceof SplitError) return { recorded: false, error: error.message };
      throw error;
    }
  },
};

const undoTool: ToolDef = {
  name: "undo_last",
  description: "Undo the most recent expense the sender logged. Use when they say undo, scratch that, or it was wrong.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  run(_input, ctx) {
    const undone = undoLastExpense(ctx.db, ctx.household.id, ctx.member.id);
    return undone ? { undone: true, total: formatCents(undone.totalCents) } : { undone: false, note: "nothing to undo" };
  },
};

const balancesTool: ToolDef = {
  name: "get_balances",
  description: "The sender's balances with roommates (groceries and shared waste combined). Use for \"what do I owe?\" or \"who owes me?\".",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  run(_input, ctx) {
    const { netCents, lines } = balancesFor(ctx.db, ctx.household.id, ctx.member.id);
    const facts = {
      net: netCents === 0 ? "all square" : netCents > 0 ? `you are owed ${formatCents(netCents)}` : `you owe ${formatCents(-netCents)}`,
      breakdown: lines.map((l) =>
        l.netCents > 0
          ? `${nameOf(ctx, l.otherMemberId)} owes you ${formatCents(l.netCents)}`
          : `you owe ${nameOf(ctx, l.otherMemberId)} ${formatCents(-l.netCents)}`,
      ),
    };
    if (!ctx.isGroup) return facts;
    // Balances are personal: send them by DM and tell Claude only that it was sent.
    ctx.drafts.push({
      audience: { kind: "member", memberId: ctx.member.id },
      sensitivity: "personal",
      subjectMemberId: ctx.member.id,
      text: [`Your balance: ${facts.net}.`, ...facts.breakdown].join("\n"),
    });
    return { sent_privately: true, note: "Balances are private. They were sent to the person's DM. Say so; do not mention amounts." };
  },
};

const shelfLifeTool: ToolDef = {
  name: "shelf_life_lookup",
  description:
    "Search the USDA FoodKeeper table for a food. Returns up to 5 matching entries with how long each lasts in the pantry, fridge, and freezer. " +
    "Always use this before saying how long food lasts, and only quote the durations it returns. If raw vs cooked matters and is unclear, ask.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "The food, e.g. \"baby spinach\"" } },
    required: ["query"],
    additionalProperties: false,
  },
  run(input, ctx) {
    const describe = (min: number | null, max: number | null, note: string | null) =>
      min === null ? (note ?? "not listed") : min === max ? `${min} days` : `${min}-${max} days`;
    const matches = searchShelfLife(ctx.db, String(input.query)).map((m) => {
      const row = ctx.db.query<ShelfLifeRow, [number]>("SELECT * FROM shelf_life WHERE id = ?").get(m.id)!;
      return {
        id: m.id,
        food: m.subtitle ? `${m.name.trim()} (${m.subtitle})` : m.name.trim(),
        pantry: describe(row.pantry_min_days, row.pantry_max_days, row.pantry_note),
        fridge: describe(row.fridge_min_days, row.fridge_max_days, row.fridge_note),
        freezer: describe(row.freezer_min_days, row.freezer_max_days, row.freezer_note),
      };
    });
    return { source: "USDA FoodKeeper", matches };
  },
};

const summaryTool: ToolDef = {
  name: "get_household_summary",
  description: "Household name and roommate names. Use when you need to know who is in the household.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  run(_input, ctx) {
    return { household: ctx.household.name, members: ctx.members.map((m) => m.name), you_are_talking_to: ctx.member.name };
  },
};

const describeItem = (ctx: ToolContext, i: Item) => ({
  item: i.name,
  status: expiryPhrase(i, ctx.household.tz, itemNote(ctx.db, i)),
  storage: i.storage,
});

const addItemTool: ToolDef = {
  name: "add_item",
  description:
    "Log food someone bought or put in the fridge. Code computes each expiry date from USDA FoodKeeper; never state one yourself, " +
    "only repeat what this returns. Prefer calling shelf_life_lookup first and passing the matching food_id. " +
    "Groceries just bought are raw (state \"raw\"); leftovers or cooked dishes are \"cooked\". If it returns needs_clarification, ask the user.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "What the user called it, e.g. \"baby spinach\"" },
            food_id: { type: "integer", description: "FoodKeeper id from shelf_life_lookup" },
            storage: { type: "string", enum: ["fridge", "pantry", "freezer"], description: "Only if the user said or it's obvious" },
            state: { type: "string", enum: ["raw", "cooked"] },
            owner: { type: "string", enum: ["shared", "me"], description: "\"me\" only if they said it's just theirs. Default shared." },
            price: { type: "string", description: "Only if the user gave one, as written" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  run(input, ctx) {
    const added: ToolResult[] = [];
    const personal: string[] = [];
    const problems: ToolResult[] = [];
    for (const it of (input.items ?? []) as { name: string; food_id?: number; storage?: Storage; state?: "raw" | "cooked"; owner?: string; price?: string }[]) {
      const name = String(it.name ?? "").trim();
      if (!name) continue;
      const own = it.owner === "me";
      const r = addItem(ctx.db, {
        householdId: ctx.household.id,
        name,
        buyerId: ctx.member.id,
        ownerId: own ? ctx.member.id : null,
        shelfLifeId: typeof it.food_id === "number" ? it.food_id : undefined,
        storage: ["fridge", "pantry", "freezer"].includes(String(it.storage)) ? it.storage : undefined,
        state: it.state === "raw" || it.state === "cooked" ? it.state : undefined,
        priceCents: it.price ? parseCents(String(it.price)) : null,
      });
      if (!r.ok) {
        problems.push(
          r.reason === "ambiguous"
            ? { item: name, needs_clarification: "raw or cooked?", usda_options: r.options }
            : { item: name, not_found: "not in the USDA FoodKeeper table; ask what kind of food it is" },
        );
        continue;
      }
      const line = `${name}: ${expiryPhrase(r.item, ctx.household.tz, r.note)} (${r.item.storage}, USDA FoodKeeper: ${r.food})`;
      if (own && ctx.isGroup) personal.push(line);
      else added.push({ ...describeItem(ctx, r.item), shared: !own, usda_food: r.food });
    }
    if (personal.length) {
      ctx.drafts.push({
        audience: { kind: "member", memberId: ctx.member.id },
        sensitivity: "personal",
        subjectMemberId: ctx.member.id,
        text: ["Logged as just yours:", ...personal].join("\n"),
      });
    }
    return {
      added,
      ...(personal.length ? { personal_items_logged_privately: personal.length, note: "Personal items were confirmed by DM. Don't name them in the group." } : {}),
      ...(problems.length ? { problems } : {}),
    };
  },
};

function statusTool(name: "use_item" | "log_toss", status: "used" | "tossed", description: string): ToolDef {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties: { item: { type: "string", description: "The food as the user said it, e.g. \"the spinach\"" } },
      required: ["item"],
      additionalProperties: false,
    },
    run(input, ctx) {
      const item = findItem(ctx.db, ctx.household.id, ctx.member.id, String(input.item ?? ""));
      if (!item) return { done: false, note: `nothing called "${input.item}" in the fridge list` };
      const rescued = status === "used" && isAtRisk(item) && !isPast(item);
      setItemStatus(ctx.db, item.id, status);
      return { done: true, item: item.name, status, ...(rescued ? { rescued: true, note: "It was about to expire: a rescue." } : {}) };
    },
  };
}

const useItemTool = statusTool("use_item", "used", "Mark food as used up or eaten. Use for \"used the X\", \"finished the X\", \"ate the X\", \"I cooked it\".");
const tossItemTool = statusTool("log_toss", "tossed", "Mark food as thrown out. Use for \"tossed the X\", \"threw out the X\", \"the X went bad\".");

const inventoryTool: ToolDef = {
  name: "get_inventory",
  description:
    "What's in the fridge, pantry, and freezer, soonest to expire first, with each item's expiry from USDA FoodKeeper. " +
    "Use for \"what's in the fridge?\", \"what's expiring?\", or before suggesting what to eat.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  run(_input, ctx) {
    const all = visibleItems(ctx.db, ctx.household.id, ctx.member.id, { sharedOnly: ctx.isGroup });
    const shared = all.filter((i) => i.owner_member_id === null).map((i) => describeItem(ctx, i));
    const yours = all.filter((i) => i.owner_member_id === ctx.member.id).map((i) => describeItem(ctx, i));
    if (all.length === 0) return { items: [], note: "Nothing logged yet." };
    return ctx.isGroup ? { shared } : { shared, yours };
  },
};

/** Shared items from the latest group reminder that are still fresh and not past their date (claimed or not). */
function lastRemindedItems(ctx: ToolContext): Item[] {
  const last = ctx.db
    .query<{ sent_at: string }, [number]>(
      `SELECT n.sent_at FROM nudges n JOIN items i ON i.id = n.item_id WHERE i.household_id = ? AND n.audience = 'group' ORDER BY n.sent_at DESC LIMIT 1`,
    )
    .get(ctx.household.id);
  if (!last) return [];
  return ctx.db
    .query<Item, [number, string]>(
      `SELECT i.* FROM nudges n JOIN items i ON i.id = n.item_id
        WHERE i.household_id = ? AND n.audience = 'group' AND n.sent_at = ? AND i.status = 'fresh' AND i.owner_member_id IS NULL`,
    )
    .all(ctx.household.id, last.sent_at)
    .filter((i) => !isPast(i));
}

const claimTool: ToolDef = {
  name: "claim_item",
  description:
    "Claim a shared item for the sender (\"mine\", \"I'll take the spinach\", \"dibs\"). Code decides who wins: the first claim by send time. " +
    "Omit item when they just said \"mine\" after a reminder. Report exactly what this returns.",
  input_schema: {
    type: "object",
    properties: { item: { type: "string", description: "The food, if they named it" } },
    additionalProperties: false,
  },
  run(input, ctx) {
    const phrase = String(input.item ?? "").trim();
    const reminded = lastRemindedItems(ctx);
    const open = reminded.filter((i) => claimWinner(ctx.db, i.id) === null);
    // A bare "mine" means the one open item; if the only reminded item is taken, claim it anyway so they hear who won.
    const recent = open.length ? open : reminded;
    let item: Item | null = null;
    if (phrase) {
      item = matchItem(reminded, phrase) ?? findItem(ctx.db, ctx.household.id, ctx.member.id, phrase, { sharedOnly: true });
      if (!item) return { claimed: false, note: `no shared item called "${phrase}"` };
    } else if (recent.length === 1) {
      item = recent[0]!;
    } else if (recent.length > 1) {
      return { claimed: false, which_one: recent.map((i) => i.name), note: "Ask which one they want." };
    } else {
      return { claimed: false, note: "Ask which item they mean." };
    }
    if (isPast(item)) return { claimed: false, item: item.name, past_usda_date: true, note: "It's past its USDA FoodKeeper date: tell them to toss it, not eat it." };

    const outcome = claimItem(ctx.db, item.id, ctx.member.id, ctx.messageId ?? null, claimTime(ctx.sentAt));
    const winner = nameOf(ctx, outcome.winnerMemberId);
    if (outcome.replacedMemberId !== undefined) {
      ctx.drafts.push({
        audience: { kind: "group" },
        sensitivity: "household",
        text: `Update on the ${item.name}: ${winner} asked first, so it's ${winner}'s. Sorry, ${nameOf(ctx, outcome.replacedMemberId)}!`,
      });
    }
    return outcome.won
      ? { claimed: true, item: item.name, winner, status: expiryPhrase(item, ctx.household.tz), ...(outcome.repeat ? { note: "already theirs" } : {}) }
      : { claimed: false, item: item.name, winner, note: `${winner} claimed it first.` };
  },
};

export const TOOLS: ToolDef[] = [
  recordExpenseTool,
  undoTool,
  balancesTool,
  shelfLifeTool,
  addItemTool,
  useItemTool,
  tossItemTool,
  inventoryTool,
  claimTool,
  summaryTool,
];

/** Drop keys Gemini's schema subset may reject (additionalProperties), recursively. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) if (k !== "additionalProperties") out[k] = geminiSchema(v);
  return out;
}

export function toolDefinitions(): FunctionTool[] {
  return TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) as JsonSchema }));
}

export function runTool(name: string, input: unknown, ctx: ToolContext): ToolResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `unknown tool ${name}` };
  return tool.run(input ?? {}, ctx);
}
